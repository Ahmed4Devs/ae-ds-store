"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { readCart, clearCart } from "@/lib/cart";
import { shippingAddressSchema } from "@/lib/ksa";
import { createLocalOrder } from "@/lib/orders";
import { getCurrentUser } from "@/lib/session";
import { rememberGuestOrder } from "@/lib/guest-orders";
import { getDictionary, getLocale } from "@/lib/i18n";

/**
 * إجراء إتمام الشراء.
 *
 * ينتهي هذا الإجراء عند **تثبيت الطلبية**، لا عند شرائها:
 *   1. تثبيت الطلبية محليًا مع مفتاح منع التكرار وسعر الصرف
 *   2. تحويل العميل إلى صفحة الدفع
 *
 * ثم — وبعد تأكيد الدفع وحده — يتولّى `onPaymentSucceeded` تحديدَ الطلبية
 * مدفوعةً وشراءها من AliExpress.
 *
 * كان هذا الإجراء سابقًا يستدعي `markOrderPaid` مباشرةً ثم يشتري فورًا،
 * أي أن كل زائر يضغط «تأكيد الطلب» كان يصرف مالًا حقيقيًا من حساب المتجر
 * بلا أن يدفع ريالًا. فصلُ الدفع ليس تحسينًا للتجربة بل إصلاح لذلك.
 *
 * وفصل التثبيت عن الشراء يبقى ضروريًا لسببه الأصلي أيضًا: لو استُدعيت
 * المنصة أولًا وفشل الحفظ المحلي لصار لدينا شراء بلا طلبية.
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

  // معرّف الطلبية الداخلي لم يعد لازمًا هنا: الدفع والتوريد انتقلا إلى
  // ما بعد هذا الإجراء، وصفحة الدفع تجد الطلبية برقمها الظاهر.
  let orderNumber: string;
  try {
    const created = await createLocalOrder({
      cart,
      address,
      locale,
      userId: user?.id,
      addressId,
      // حقل حرّ لا يُتحقَّق منه بمخطّط — نحدّ طوله منعًا لتضخّم التخزين
      notes:
        (formData.get("notes") as string)?.trim().slice(0, 500) || undefined,
    });
    orderNumber = created.orderNumber;
  } catch (e) {
    return {
      formError: e instanceof Error ? e.message : t.checkout.createFailed,
    };
  }

  // طلبية الضيف تُربَط بهذا المتصفّح حتى لا يقرأها غيره بمعرفة رقمها فقط
  if (!user) {
    await rememberGuestOrder(orderNumber);
  }

  /**
   * تُفرَّغ السلة الآن لا بعد الدفع.
   *
   * الأسعار والمخزون قد ثُبِّتت على أسطر الطلبية بالفعل، فبقاء السلة
   * مليئة كان يدعو العميل إلى إنشاء طلبية ثانية بالمحتوى نفسه وهو يظنّ
   * أن الأولى لم تُسجَّل. ولو تُرك الدفع فسيجد الطلبية بانتظاره في
   * «طلباتي» مع زرّ إتمام الدفع.
   */
  await clearCart();
  revalidatePath("/orders");

  // redirect يرمي خطأ تحكّمي في Next — يجب أن يبقى خارج أي try/catch
  redirect(`/pay/${orderNumber}`);
}
