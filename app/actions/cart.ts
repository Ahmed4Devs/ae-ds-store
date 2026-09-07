"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  addToCart,
  CartLimitError,
  cartItemSchema,
  clearCart,
  updateCartQuantity,
} from "@/lib/cart";
import { getDictionary } from "@/lib/i18n";

/**
 * إجراءات السلة.
 *
 * تحذير Next.js 16 الموثّق: إجراءات الخادم قابلة للاستدعاء عبر طلب POST
 * مباشر لا عبر الواجهة فقط — لذا يُتحقق من المدخلات هنا دائمًا بـ zod،
 * ولا يُفترض أن المتصفّح هو المصدر.
 */

const addSchema = cartItemSchema;

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function addToCartAction(
  input: z.input<typeof addSchema>,
): Promise<ActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: (await getDictionary()).common.unexpectedError };
  }

  try {
    await addToCart(parsed.data);
  } catch (error) {
    const t = await getDictionary();
    if (error instanceof CartLimitError) {
      return { ok: false, error: t.cart.limitReached };
    }
    // لا تمرّر خطأ الكوكي/التوقيع أو إطار الخادم إلى المتصفح.
    return { ok: false, error: t.common.unexpectedError };
  }
  revalidatePath("/cart");
  return { ok: true };
}

const updateSchema = cartItemSchema.extend({
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
