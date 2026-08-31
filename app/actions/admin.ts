"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isAdmin } from "@/lib/session";
import { sourceOrderFromAliExpress } from "@/lib/orders";
import { syncActiveOrders } from "@/lib/order-sync";
import { fill, getDictionary } from "@/lib/i18n";

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
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const parsed = orderIdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: t.admin.invalidData };
  }

  const result = await sourceOrderFromAliExpress(parsed.data.orderId, {
    tryToPay: false,
  });

  revalidatePath("/admin/orders");

  if (result.ok) {
    return {
      ok: true,
      message: fill(t.admin.sourcedOk, { n: result.aeOrderIds.length }),
    };
  }

  return {
    ok: false,
    message: `${result.errorCode}: ${result.message}${
      result.retryable ? "" : t.admin.notRetriedAuto
    }`,
  };
}

export async function syncOrdersAction(): Promise<AdminActionResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const res = await syncActiveOrders(50);
  revalidatePath("/admin/orders");

  const base = fill(t.admin.syncResult, {
    polled: res.polled,
    updated: res.updated,
  });
  const suffix =
    res.errors.length > 0 ? fill(t.admin.syncFailed, { n: res.errors.length }) : "";

  return { ok: true, message: base + suffix };
}
