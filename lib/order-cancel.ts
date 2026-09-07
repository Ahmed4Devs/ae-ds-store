import { prisma } from "@/lib/db";
import type { OrderStatus } from "@/lib/generated/prisma/client";
import { safeErrorKind } from "@/lib/safe-log";

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
 * هل تسمح حالة الطلبية بالإلغاء من طرفنا بلا عملية استرداد؟
 *
 * لا توجد في هذا المشروع بعدُ دالة Refund تنفّذ الاسترداد عند المزوّد
 * وتثبته. لذلك الإلغاء الذاتي محصور بما قبل الدفع؛ PAID وSOURCING_FAILED
 * تُرفضان مؤقتًا بدل كتابة CANCELLED توحي بأن المال عاد وهو لم يعد.
 */
export function canCancel(status: OrderStatus): boolean {
  return status === "PENDING_PAYMENT";
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
      payments: {
        where: {
          status: { in: [...OPEN_PAYMENT_STATUSES] },
          provider: { not: "manual" },
        },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!order) return { ok: false, reason: "NOT_FOUND" };

  // فحص مبكر لرسالة واضحة — لكن القرار الفعلي كتابةٌ شرطية أدناه، لأن هذا
  // الفحص قراءةٌ قد يسبقها توريدٌ يبدأ بين القراءة والكتابة.
  const unsafeWithoutRefund =
    !canCancel(order.status) ||
    order.aeOrders.length > 0 ||
    order.payments.length > 0 ||
    order.needsManualReview;
  if (unsafeWithoutRefund) {
    // إلغاء المورّد لطلبية مدفوعة ليس استردادًا لدى بوابة العميل. نرفعها
    // للمراجعة ولا نمثّلها CANCELLED حتى يضاف workflow استرداد موثّق.
    if (
      opts.actor === "system" &&
      order.status !== "CANCELLED" &&
      order.status !== "DELIVERED"
    ) {
      await prisma.order.updateMany({
        where: { id: order.id },
        data: { needsManualReview: true },
      });
    }
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
  const guard = {
    status: "PENDING_PAYMENT" as const,
    aeOrders: { none: {} },
    // لا نكتب CANCELLED بينما توجد صفحة دفع خارجية حيّة لا نملك بعدُ
    // workflow لإلغائها/استردادها لدى المزوّد. الحارس داخل الكتابة نفسها
    // يغلق سباق إنشاء النيّة مع ضغط «إلغاء» في تبويب آخر.
    payments: {
      none: {
        status: { in: [...OPEN_PAYMENT_STATUSES] },
        provider: { not: "manual" },
      },
    },
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
    console.error(
      "[order-cancel] تعذّر إرسال بريد الإلغاء:",
      safeErrorKind(e),
    );
  }

  return { ok: true };
}
