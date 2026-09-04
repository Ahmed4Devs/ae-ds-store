import { prisma } from "@/lib/db";
import type { OrderStatus } from "@/lib/generated/prisma/client";

/**
 * إلغاء الطلبية.
 *
 * نقطة واحدة يمرّ منها كل إلغاء — من العميل أو المسؤول أو المزامنة الآلية —
 * لأن الإلغاء ليس تغيير حقل: يجب أن تُبطَل معه نيّات الدفع المعلّقة ويُخطَر
 * العميل. كتابة `status = CANCELLED` مباشرةً في أي مكان آخر تتخطّى الاثنين.
 */

export type CancelActor = "customer" | "admin" | "system";

/** حدّ أقصى لطول السبب المخزَّن — الحقل حرّ ويأتي من إدخال المستخدم. */
const MAX_REASON = 500;

/**
 * هل تسمح حالة الطلبية بالإلغاء من طرفنا؟
 *
 * الحدّ عند SOURCING: ما إن تتجاوز الطلبية هذه النقطة تكون موجودة فعلًا على
 * AliExpress ودُفع ثمنها هناك. تعليمها «ملغاة» لدينا حينئذٍ لا يلغي شيئًا —
 * بل يفصل سجلّنا عن المنصة التي ذهب إليها المال، فنعد العميل باسترداد
 * بينما الشحنة في طريقها إليه. تلك الحالات تُلغى من لوحة المنصة أولًا.
 */
export function canCancel(status: OrderStatus): boolean {
  return (
    status === "PENDING_PAYMENT" ||
    status === "PAID" ||
    status === "SOURCING_FAILED"
  );
}

/** حالات الدفع غير النهائية — هي وحدها ما يُبطَل عند الإلغاء. */
const OPEN_PAYMENT_STATUSES = ["REQUIRES_ACTION", "PENDING"] as const;

export type CancelResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" | "NOT_CANCELLABLE" };

export async function cancelOrder(
  orderId: string,
  opts: { actor: CancelActor; reason?: string },
): Promise<CancelResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      needsManualReview: true,
      aeOrders: { select: { id: true } },
    },
  });

  if (!order) return { ok: false, reason: "NOT_FOUND" };

  // فحص مبكر لرسالة واضحة — لكن القرار الفعلي كتابةٌ شرطية أدناه، لأن هذا
  // الفحص قراءةٌ قد يسبقها توريدٌ يبدأ بين القراءة والكتابة.
  const mirrorsPlatform = opts.actor === "system";
  if (!mirrorsPlatform) {
    // وجود صفّ aeOrder أو علَم المراجعة اليدوية دليلٌ قاطع على أن الطلبية
    // أُنشئت لدى المورّد، فلا تُلغى ذاتيًا مهما بدت الحالة قابلة.
    if (
      !canCancel(order.status) ||
      order.aeOrders.length > 0 ||
      order.needsManualReview
    ) {
      return { ok: false, reason: "NOT_CANCELLABLE" };
    }
  } else if (order.status === "CANCELLED" || order.status === "DELIVERED") {
    return { ok: false, reason: "NOT_CANCELLABLE" };
  }

  const reason = opts.reason?.trim()
    ? `${opts.actor}: ${opts.reason.trim()}`.slice(0, MAX_REASON)
    : opts.actor;

  /**
   * الإلغاء كتابة **شرطية** لا مطلقة.
   *
   * كان بين الفحص أعلاه والكتابة أدناه نافذةُ تسابق: لو بدأ التوريد فيها
   * (وصل إشعار دفع فاشترى من المنصة وكتب SOURCED + صفوف AeOrder) لكانت
   * الكتابة غير المشروطة تطمس SOURCED بـ CANCELLED — فنَعِد العميل باسترداد
   * بينما الشحنة في طريقها إليه ومالُنا عند المورّد. الشرط في WHERE يجعل
   * الفائز واحدًا: من لا تتحقّق شروطه يخرج بـ NOT_CANCELLABLE.
   */
  const guard = mirrorsPlatform
    ? { status: { notIn: ["CANCELLED", "DELIVERED"] as OrderStatus[] } }
    : {
        status: {
          in: ["PENDING_PAYMENT", "PAID", "SOURCING_FAILED"] as OrderStatus[],
        },
        aeOrders: { none: {} },
        needsManualReview: false,
      };

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: order.id, ...guard },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: reason,
      },
    });

    if (claimed.count === 0) return false;

    // إبطال نيّات الدفع المفتوحة ضمن المعاملة نفسها: لو بقيت مفتوحة لأمكن
    // لإشعار متأخّر من المزوّد أن يصل بعد الإلغاء فيُعيد الطلبية إلى PAID
    // ويشتريها من المورّد — طلبية أُلغيت للعميل ثم اشتُريت خلف ظهره.
    await tx.paymentIntent.updateMany({
      where: { orderId: order.id, status: { in: [...OPEN_PAYMENT_STATUSES] } },
      data: { status: "EXPIRED" },
    });
    return true;
  });

  if (!result) return { ok: false, reason: "NOT_CANCELLABLE" };

  // البريد خارج المعاملة وباستيراد ديناميكي: انقطاع مزوّد البريد أو بطؤه
  // يجب ألّا يُبقي معاملة قاعدة البيانات مفتوحة ولا أن يُفشل إلغاءً تمّ.
  try {
    const { sendOrderCancelledMail } = await import("@/lib/mail");
    await sendOrderCancelledMail(order.id);
  } catch (e) {
    console.error("[order-cancel] تعذّر إرسال بريد الإلغاء:", e);
  }

  return { ok: true };
}
