"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isAdmin } from "@/lib/session";
import { sourceOrderFromAliExpress } from "@/lib/orders";
import { syncActiveOrders } from "@/lib/order-sync";

/**
 * إجراءات الإدارة.
 *
 * كل إجراء يتحقق من الصلاحية بنفسه — لا يُعتمد على حماية التخطيط وحدها،
 * لأن إجراءات الخادم قابلة للاستدعاء بطلب POST مباشر كما ينص توثيق
 * Next.js 16 صراحةً.
 */

const orderIdSchema = z.object({ orderId: z.string().min(1) });

export type AdminActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export async function retrySourcingAction(
  input: z.input<typeof orderIdSchema>,
): Promise<AdminActionResult> {
  if (!(await isAdmin())) {
    return { ok: false, message: "غير مصرّح" };
  }

  const parsed = orderIdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "بيانات غير صالحة" };
  }

  const result = await sourceOrderFromAliExpress(parsed.data.orderId, {
    tryToPay: false,
  });

  revalidatePath("/admin/orders");

  if (result.ok) {
    return {
      ok: true,
      message: `تم التوريد بنجاح (${result.aeOrderIds.length} طلبية لدى AliExpress)`,
    };
  }

  return {
    ok: false,
    message: `${result.errorCode}: ${result.message}${
      result.retryable ? "" : " — هذا الخطأ لا يُعاد آليًا"
    }`,
  };
}

export async function syncOrdersAction(): Promise<AdminActionResult> {
  if (!(await isAdmin())) {
    return { ok: false, message: "غير مصرّح" };
  }

  const res = await syncActiveOrders(50);
  revalidatePath("/admin/orders");

  return {
    ok: true,
    message: `تم استقصاء ${res.polled} طلبية، وتحدّثت ${res.updated}${
      res.errors.length > 0 ? `، وفشل ${res.errors.length}` : ""
    }`,
  };
}
