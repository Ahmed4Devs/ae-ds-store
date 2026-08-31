"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { readCart, clearCart } from "@/lib/cart";
import { shippingAddressSchema } from "@/lib/ksa";
import { createLocalOrder, markOrderPaid, sourceOrderFromAliExpress } from "@/lib/orders";
import { getCurrentUser } from "@/lib/session";
import { getDictionary, getLocale } from "@/lib/i18n";

/**
 * إجراء إتمام الشراء.
 *
 * التسلسل مقصود:
 *   1. تثبيت الطلبية محليًا مع مفتاح منع التكرار وسعر الصرف
 *   2. تسجيل الدفع (بديل بوابة الدفع — يُستبدل بمدى/Tap لاحقًا)
 *   3. الشراء من AliExpress
 *
 * فصل الخطوة 1 عن 3 ضروري: لو استُدعيت المنصة أولًا وفشل الحفظ المحلي
 * لصار لدينا شراء بلا طلبية.
 */

export type CheckoutState = {
  errors?: Record<string, string>;
  formError?: string;
};

export async function checkoutAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const [cart, t, locale] = await Promise.all([
    readCart(),
    getDictionary(),
    getLocale(),
  ]);

  if (cart.length === 0) {
    return { formError: t.checkout.cartEmpty };
  }

  const parsed = shippingAddressSchema.safeParse({
    fullName: formData.get("fullName"),
    phone: formData.get("phone"),
    province: formData.get("province"),
    city: formData.get("city"),
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2") || "",
    postalCode: formData.get("postalCode") || "",
    nationalAddress: formData.get("nationalAddress") || "",
    country: "SA",
  });

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      errors[key] ??= issue.message;
    }
    return { errors };
  }

  const user = await getCurrentUser();
  const address = parsed.data;
  const saveAddress = formData.get("saveAddress") === "on";

  let addressId: string | undefined;
  if (user && saveAddress) {
    const saved = await prisma.address.create({
      data: {
        userId: user.id,
        fullName: address.fullName,
        phone: address.phone,
        country: address.country,
        province: address.province,
        city: address.city,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2 || null,
        postalCode: address.postalCode || null,
        nationalAddr: address.nationalAddress || null,
      },
      select: { id: true },
    });
    addressId = saved.id;
  }

  let orderId: string;
  let orderNumber: string;
  try {
    const created = await createLocalOrder({
      cart,
      address,
      locale,
      userId: user?.id,
      addressId,
      notes: (formData.get("notes") as string) || undefined,
    });
    orderId = created.orderId;
    orderNumber = created.orderNumber;
  } catch (e) {
    return {
      formError: e instanceof Error ? e.message : t.checkout.createFailed,
    };
  }

  // --- بديل بوابة الدفع -------------------------------------------------
  // هنا يُدمج مزوّد سعودي (مدى / Tap / Moyasar / HyperPay).
  // في هذه النسخة نعتبر الدفع ناجحًا مباشرة.
  await markOrderPaid(orderId);

  // --- الشراء من AliExpress --------------------------------------------
  // tryToPay=false عمدًا: تفعيله يتطلب حسابًا مفوَّضًا كدروبشيبينغ
  // وفق ما ينص عليه توثيق الحقل صراحةً.
  await sourceOrderFromAliExpress(orderId, { tryToPay: false });

  await clearCart();
  revalidatePath("/orders");
  redirect(`/orders/${orderNumber}?new=1`);
}
