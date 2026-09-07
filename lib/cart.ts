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

const printableValue = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));

/**
 * نفس الحدود تُستخدم عند دخول الإجراء وعند قراءة الكوكي. إبقاؤها هنا
 * يمنع قبول قيمة اليوم ثم الوثوق بها لاحقًا بعد تغيّر أحد المسارين، كما
 * يبقي القيمة الموقّعة دون حد المتصفّحات العملي لحجم الكوكي.
 */
export const cartItemSchema = z
  .object({
  aeProductId: z.string().regex(/^\d{5,32}$/),
  /** الحقل الذي تتطلبه ds.order.create */
  skuAttr: printableValue(96),
  quantity: z.number().int().min(1).max(20),
  /** رمز خدمة الشحن المختار — من delivery_options[].code */
  logisticsServiceName: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  })
  .strict();

// سقف 10 أسطر: كل سطر يستدعي المنتج والشحن من المصدر، فالسقف يحدّ كلفة
// تجميع السلة ويقلّص سطح الاستغلال التضخيمي.
export const CART_MAX_LINES = 10;
export const cartSchema = z.array(cartItemSchema).max(CART_MAX_LINES);

export type CartItem = z.infer<typeof cartItemSchema>;
export type Cart = z.infer<typeof cartSchema>;

const COOKIE = "ae_ds_cart";
const COOKIE_PURPOSE = "cart";
const MAX_AGE = 60 * 60 * 24 * 14; // أسبوعان

export async function readCart(): Promise<Cart> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  if (!raw) return [];

  // الكوكي موقّع: نرفض أي قيمة لم يصدرها الخادم (سلة مزوّرة)
  const value = unsign(raw, COOKIE_PURPOSE);
  if (!value) return [];

  try {
    const parsed = cartSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export class CartLimitError extends Error {
  constructor() {
    super("CART_LINE_LIMIT");
    this.name = "CartLimitError";
  }
}

export async function writeCart(cart: Cart): Promise<void> {
  const store = await cookies();
  if (cart.length === 0) {
    store.delete(COOKIE);
    return;
  }

  // لا يكفي نوع TypeScript عند هذا الحد: الدوال الداخلية أو تغيّر الكود
  // مستقبلًا قد يمرّر مصفوفة أكبر من سقف الكلفة. لا نوقّع أبدًا كوكيًا لا
  // نستطيع قراءته لاحقًا؛ وإلا تُرفض السلة كلها في الزيارة التالية.
  const validated = cartSchema.parse(cart);
  store.set(COOKIE, sign(JSON.stringify(validated), COOKIE_PURPOSE), {
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
  const validatedItem = cartItemSchema.parse(item);
  const cart = await readCart();
  const existing = cart.find((c) => sameLine(c, validatedItem));
  if (existing) {
    existing.quantity = Math.min(20, existing.quantity + validatedItem.quantity);
  } else {
    if (cart.length >= CART_MAX_LINES) throw new CartLimitError();
    cart.push(validatedItem);
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
    if (line) line.quantity = Math.min(20, quantity);
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
