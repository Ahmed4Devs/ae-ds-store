"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { cancelOrder } from "@/lib/order-cancel";
import { ownsGuestOrder } from "@/lib/guest-orders";
import { getCurrentUser, isAdmin } from "@/lib/session";
import { fill, getDictionary } from "@/lib/i18n";

/**
 * إجراءات الطلبية المتاحة للعميل.
 *
 * كل إجراء يتحقق من الملكية بنفسه: إجراءات الخادم مسارات POST حقيقية
 * قابلة للاستدعاء مباشرةً، فحماية الصفحة التي رُسم منها الزر لا تحمي شيئًا.
 */

const customerCancelSchema = z.object({
  orderNumber: z.string().min(1),
  reason: z.string().max(500).optional(),
});

const adminCancelSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export type OrderActionResult = { ok: boolean; message: string };

export async function cancelOrderAction(
  input: z.input<typeof customerCancelSchema>,
): Promise<OrderActionResult> {
  const t = await getDictionary();

  const parsed = customerCancelSchema.safeParse(input);
  // رسالة عامة لا تكشف سبب الرفض — أخطاء التحقق تفاصيل داخلية
  if (!parsed.success) {
    return { ok: false, message: t.orders.cancelFailed };
  }

  const { orderNumber, reason } = parsed.data;

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, userId: true },
  });

  // الطلبية غير الموجودة والطلبية المملوكة لغيرك تُعطيان الرسالة نفسها:
  // لو تمايزتا لصار الإجراء مِجَسًّا يكشف أي أرقام الطلبيات حقيقية.
  if (!order) {
    return { ok: false, message: t.orders.cancelFailed };
  }

  const user = await getCurrentUser();
  const owns = order.userId
    ? order.userId === user?.id
    : await ownsGuestOrder(orderNumber);

  if (!owns) {
    return { ok: false, message: t.orders.cancelFailed };
  }

  const result = await cancelOrder(order.id, { actor: "customer", reason });

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "NOT_CANCELLABLE"
          ? t.orders.cannotCancel
          : t.orders.cancelFailed,
    };
  }

  revalidatePath(`/orders/${orderNumber}`);
  return { ok: true, message: t.orders.cancelledTitle };
}

export async function adminCancelOrderAction(
  input: z.input<typeof adminCancelSchema>,
): Promise<OrderActionResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const parsed = adminCancelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: t.admin.invalidData };
  }

  const result = await cancelOrder(parsed.data.orderId, {
    actor: "admin",
    reason: parsed.data.reason,
  });

  if (!result.ok) {
    return {
      ok: false,
      message: fill(t.admin.cancelOrderFailed, {
        msg:
          result.reason === "NOT_CANCELLABLE"
            ? t.orders.cannotCancel
            : t.orders.cancelFailed,
      }),
    };
  }

  revalidatePath("/admin/orders");
  return { ok: true, message: t.admin.orderCancelled };
}
