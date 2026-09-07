"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { readCart, clearCart } from "@/lib/cart";
import { shippingAddressSchema } from "@/lib/ksa";
import { createLocalOrder, deriveCheckoutSecurity } from "@/lib/orders";
import { getCurrentUser } from "@/lib/session";
import { rememberGuestOrder } from "@/lib/guest-orders";
import { getDictionary, getLocale } from "@/lib/i18n";
import { safeErrorKind } from "@/lib/safe-log";

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

const checkoutTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export async function checkoutAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const [cart, t, locale, user] = await Promise.all([
    readCart(),
    getDictionary(),
    getLocale(),
    getCurrentUser(),
  ]);

  const checkoutToken = checkoutTokenSchema.safeParse(
    formData.get("checkoutToken"),
  );
  if (!checkoutToken.success) {
    return { formError: t.checkout.createFailed };
  }
  const checkoutSecurity = deriveCheckoutSecurity(
    checkoutToken.data,
    user?.id,
  );

  // إذا وصل الردّ الأول متأخرًا أو أعاد المتصفح POST نفسه بعد انقطاع، فقد
  // تكون السلة قد فُرّغت بالفعل. نفحص المفتاح الدائم قبل رفض السلة الفارغة
  // ونعيد العميل إلى الطلبية نفسها. المطابقة بهوية المالك دفاع إضافي فوق
  // إدخال الهوية أصلًا في بصمة HMAC.
  const existingOrder = await prisma.order.findUnique({
    where: { checkoutKeyHash: checkoutSecurity.checkoutKeyHash },
    select: { orderNumber: true, userId: true },
  });
  if (existingOrder && existingOrder.userId === (user?.id ?? null)) {
    if (!user) {
      await rememberGuestOrder(
        existingOrder.orderNumber,
        checkoutSecurity.guestAccessToken!,
      );
    }
    await clearCart();
    redirect(`/pay/${existingOrder.orderNumber}`);
  }

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

  const address = parsed.data;
  const saveAddress = formData.get("saveAddress") === "on";
  const notesValue = formData.get("notes");
  const notes =
    typeof notesValue === "string"
      ? notesValue
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 300) || undefined
      : undefined;

  // معرّف الطلبية الداخلي لم يعد لازمًا هنا: الدفع والتوريد انتقلا إلى
  // ما بعد هذا الإجراء، وصفحة الدفع تجد الطلبية برقمها الظاهر.
  let orderNumber: string;
  try {
    const created = await createLocalOrder({
      cart,
      address,
      locale,
      userId: user?.id,
      saveAddress,
      ...checkoutSecurity,
      // حقل حرّ محدود الطول؛ أي File مصطنع لا يُحوَّل إلى نص ضمني.
      notes,
    });
    orderNumber = created.orderNumber;
  } catch (e) {
    console.error("[checkout] تعذّر تثبيت الطلبية:", safeErrorKind(e));
    return {
      // لا نعيد رسالة قاعدة البيانات أو المزوّد للعميل؛ قد تحوي أسماء
      // جداول وحقول أو تفاصيل تشغيلية تساعد على الاستطلاع.
      formError: t.checkout.createFailed,
    };
  }

  // طلبية الضيف تُربَط بهذا المتصفّح حتى لا يقرأها غيره بمعرفة رقمها فقط
  if (!user) {
    await rememberGuestOrder(orderNumber, checkoutSecurity.guestAccessToken!);
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
