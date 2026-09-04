"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ownsGuestOrder } from "@/lib/guest-orders";
import { getDictionary, getLocale } from "@/lib/i18n";
import {
  PaymentError,
  confirmManualPayment,
  createPaymentIntent,
} from "@/lib/payments";
import { getCurrentUser, isAdmin } from "@/lib/session";

/**
 * إجراءات الدفع.
 *
 * كل إجراء يتحقق من الصلاحية بنفسه لا اعتمادًا على حماية الصفحة، لأن
 * إجراءات الخادم قابلة للاستدعاء بطلب POST مباشر.
 */

const startSchema = z.object({ orderNumber: z.string().min(1).max(64) });
const confirmSchema = z.object({ intentId: z.string().min(1).max(64) });

export type StartPaymentResult =
  | { ok: true; checkoutUrl: string | null }
  | { ok: false; message: string };

export async function startPaymentAction(
  input: z.input<typeof startSchema>,
): Promise<StartPaymentResult> {
  const t = await getDictionary();

  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.payment.notFound };

  const order = await prisma.order.findUnique({
    where: { orderNumber: parsed.data.orderNumber },
    select: { id: true, userId: true },
  });

  // رسالة واحدة لغياب الطلبية ولانعدام الصلاحية: التفريق بينهما يحوّل
  // الردّ إلى أوراكل يكشف أرقام الطلبيات القائمة للمتطفّلين.
  if (!order) return { ok: false, message: t.payment.notFound };

  const authorized = order.userId
    ? (await getCurrentUser())?.id === order.userId
    : await ownsGuestOrder(parsed.data.orderNumber);

  if (!authorized) return { ok: false, message: t.payment.notFound };

  try {
    const intent = await createPaymentIntent(order.id);
    revalidatePath(`/pay/${parsed.data.orderNumber}`);
    return { ok: true, checkoutUrl: intent.checkoutUrl };
  } catch (e) {
    if (e instanceof PaymentError) {
      // رموز المزوّد لا تصل المتصفّح — تُترجَم إلى رسالة من القاموس
      const message =
        e.code === "ALREADY_PAID"
          ? t.payment.alreadyPaid
          : e.code === "ORDER_NOT_PAYABLE"
            ? t.payment.orderNotPayable
            : e.code === "ORDER_NOT_FOUND"
              ? t.payment.notFound
              : t.payment.createFailed;

      if (e.code === "PROVIDER_FAILED") {
        console.error("[payment] فشل المزوّد:", e.message);
      }
      return { ok: false, message };
    }

    console.error("[payment] خطأ غير متوقّع أثناء بدء الدفع:", e);
    return { ok: false, message: t.payment.createFailed };
  }
}

export async function confirmManualPaymentAction(
  input: z.input<typeof confirmSchema>,
): Promise<{ ok: boolean; message: string }> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.admin.invalidData };

  // اللغة تُمرَّر من سياق الطلب: الطبقة تحتها لا تقرأ الكوكيز بنفسها
  const res = await confirmManualPayment(parsed.data.intentId, await getLocale());
  revalidatePath("/admin/orders");
  return res;
}
