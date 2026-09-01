import { cookies } from "next/headers";
import { z } from "zod";
import { sign, unsign } from "@/lib/signed-cookie";

/**
 * سلة التسوّق — مخزّنة في كوكي موقّع بسيط.
 *
 * سبب اختيار الكوكي بدل قاعدة البيانات: السلة تعمل للزائر غير المسجّل،
 * وربطها بالمستخدم يفرض تسجيل الدخول قبل التصفّح.
 *
 * ملاحظة Next.js 16: cookies() غير متزامنة.
 */

const cartItemSchema = z.object({
  aeProductId: z.string(),
  /** الحقل الذي تتطلبه ds.order.create */
  skuAttr: z.string(),
  quantity: z.number().int().min(1).max(50),
  /** رمز خدمة الشحن المختار — من delivery_options[].code */
  logisticsServiceName: z.string(),
});

// سقف 10 أسطر: كل سطر يستدعي المنتج والشحن من المصدر، فالسقف يحدّ كلفة
// تجميع السلة ويقلّص سطح الاستغلال التضخيمي.
export const cartSchema = z.array(cartItemSchema).max(10);

export type CartItem = z.infer<typeof cartItemSchema>;
export type Cart = z.infer<typeof cartSchema>;

const COOKIE = "ae_ds_cart";
const MAX_AGE = 60 * 60 * 24 * 14; // أسبوعان

export async function readCart(): Promise<Cart> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  if (!raw) return [];

  // الكوكي موقّع: نرفض أي قيمة لم يصدرها الخادم (سلة مزوّرة)
  const value = unsign(raw);
  if (!value) return [];

  try {
    const parsed = cartSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function writeCart(cart: Cart): Promise<void> {
  const store = await cookies();
  if (cart.length === 0) {
    store.delete(COOKIE);
    return;
  }
  store.set(COOKIE, sign(JSON.stringify(cart)), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
}

/** يميّز سطر السلة — المنتج والتنويعة وخدمة الشحن معًا. */
function sameLine(a: CartItem, b: Omit<CartItem, "quantity">): boolean {
  return (
    a.aeProductId === b.aeProductId &&
    a.skuAttr === b.skuAttr &&
    a.logisticsServiceName === b.logisticsServiceName
  );
}

export async function addToCart(item: CartItem): Promise<Cart> {
  const cart = await readCart();
  const existing = cart.find((c) => sameLine(c, item));
  if (existing) {
    existing.quantity = Math.min(50, existing.quantity + item.quantity);
  } else {
    cart.push(item);
  }
  await writeCart(cart);
  return cart;
}

export async function updateCartQuantity(
  key: Pick<CartItem, "aeProductId" | "skuAttr" | "logisticsServiceName">,
  quantity: number,
): Promise<Cart> {
  let cart = await readCart();
  if (quantity <= 0) {
    cart = cart.filter((c) => !sameLine(c, key));
  } else {
    const line = cart.find((c) => sameLine(c, key));
    if (line) line.quantity = Math.min(50, quantity);
  }
  await writeCart(cart);
  return cart;
}

export async function clearCart(): Promise<void> {
  await writeCart([]);
}

export async function cartCount(): Promise<number> {
  const cart = await readCart();
  return cart.reduce((n, c) => n + c.quantity, 0);
}
