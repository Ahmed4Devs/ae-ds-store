"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  addToCart,
  clearCart,
  updateCartQuantity,
} from "@/lib/cart";

/**
 * إجراءات السلة.
 *
 * تحذير Next.js 16 الموثّق: إجراءات الخادم قابلة للاستدعاء عبر طلب POST
 * مباشر لا عبر الواجهة فقط — لذا يُتحقق من المدخلات هنا دائمًا بـ zod،
 * ولا يُفترض أن المتصفّح هو المصدر.
 */

const addSchema = z.object({
  aeProductId: z.string().min(1),
  skuAttr: z.string().min(1, "التنويعة مطلوبة"),
  quantity: z.number().int().min(1).max(20),
  logisticsServiceName: z.string().min(1, "طريقة الشحن مطلوبة"),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function addToCartAction(
  input: z.input<typeof addSchema>,
): Promise<ActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "بيانات غير صالحة" };
  }

  await addToCart(parsed.data);
  revalidatePath("/cart");
  return { ok: true };
}

const updateSchema = z.object({
  aeProductId: z.string().min(1),
  skuAttr: z.string().min(1),
  logisticsServiceName: z.string().min(1),
  quantity: z.number().int().min(0).max(20),
});

export async function updateCartAction(
  input: z.input<typeof updateSchema>,
): Promise<ActionResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "بيانات غير صالحة" };
  }

  const { quantity, ...key } = parsed.data;
  await updateCartQuantity(key, quantity);
  revalidatePath("/cart");
  return { ok: true };
}

export async function clearCartAction(): Promise<ActionResult> {
  await clearCart();
  revalidatePath("/cart");
  return { ok: true };
}
