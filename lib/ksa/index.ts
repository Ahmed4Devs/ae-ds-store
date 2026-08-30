import { z } from "zod";

/**
 * قواعد خاصة بالسوق السعودي.
 *
 * المصدر التقني: التوثيق الرسمي لواجهة ds.order.create يوفّر الحقل
 * `nat_addr` داخل `ds_extend_request.trade_extra_param` ويصفه بـ
 * «العنوان الوطني في السعودية»، وأمثلته `ABCD0000` و`ABCD1234`
 * أي أربعة أحرف يتبعها أربعة أرقام.
 */

/** مناطق المملكة الثلاث عشرة. */
export const SAUDI_REGIONS = [
  "الرياض",
  "مكة المكرمة",
  "المدينة المنورة",
  "القصيم",
  "المنطقة الشرقية",
  "عسير",
  "تبوك",
  "حائل",
  "الحدود الشمالية",
  "جازان",
  "نجران",
  "الباحة",
  "الجوف",
] as const;

export type SaudiRegion = (typeof SAUDI_REGIONS)[number];

/**
 * رمز العنوان الوطني السعودي المختصر (Short Address).
 * أربعة أحرف لاتينية كبيرة + أربعة أرقام، مثل RRDA2929.
 */
export const nationalAddressSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z]{4}\d{4}$/,
    "الرمز المختصر للعنوان الوطني يتكوّن من أربعة أحرف إنجليزية يتبعها أربعة أرقام (مثال: RRDA2929)",
  );

/**
 * رقم الجوال السعودي.
 * يقبل الصيغ: 05XXXXXXXX و 5XXXXXXXX و +9665XXXXXXXX و 009665XXXXXXXX
 * ويُطبّع الجميع إلى 9 خانات تبدأ بـ 5 (الصيغة التي تتوقعها الواجهة).
 */
export const saudiPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-()]/g, ""))
  .transform((v) => {
    let s = v;
    if (s.startsWith("+966")) s = s.slice(4);
    else if (s.startsWith("00966")) s = s.slice(5);
    else if (s.startsWith("966")) s = s.slice(3);
    if (s.startsWith("0")) s = s.slice(1);
    return s;
  })
  .refine(
    (s) => /^5\d{8}$/.test(s),
    "رقم الجوال يجب أن يكون سعوديًا صالحًا (مثال: 0512345678)",
  );

/** الرمز البريدي السعودي: خمس خانات. */
export const saudiPostalCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{5}$/, "الرمز البريدي يتكوّن من خمس خانات");

/**
 * مخطّط عنوان الشحن.
 * الحقول الإلزامية هنا تقابل ما ينص عليه التوثيق كـ required في
 * `logistics_address`: address, city, country, province.
 */
export const shippingAddressSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(3, "الاسم الكامل مطلوب")
    .max(80, "الاسم طويل جدًا"),
  phone: saudiPhoneSchema,
  country: z.literal("SA").default("SA"),
  province: z.enum(SAUDI_REGIONS, {
    message: "يُرجى اختيار المنطقة",
  }),
  city: z.string().trim().min(2, "المدينة مطلوبة").max(60),
  addressLine1: z
    .string()
    .trim()
    .min(5, "العنوان التفصيلي مطلوب (الشارع والحي ورقم المبنى)")
    .max(200),
  addressLine2: z.string().trim().max(200).optional().or(z.literal("")),
  postalCode: saudiPostalCodeSchema.optional().or(z.literal("")),
  /**
   * اختياري لكن يُنصح به بشدة: العنوان الوطني هو المعيار المعتمد
   * في المملكة، ووجوده يقلّل حالات فشل التسليم.
   */
  nationalAddress: nationalAddressSchema.optional().or(z.literal("")),
});

export type ShippingAddressInput = z.input<typeof shippingAddressSchema>;
export type ShippingAddress = z.output<typeof shippingAddressSchema>;

/** يعرض رقم الجوال بصيغة محلية مقروءة. */
export function formatSaudiPhone(phone9: string): string {
  if (!/^5\d{8}$/.test(phone9)) return phone9;
  return `0${phone9.slice(0, 2)} ${phone9.slice(2, 5)} ${phone9.slice(5)}`;
}

/** تنسيق تاريخ ميلادي بالعربية بتوقيت الرياض. */
export function formatDateAr(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("ar-SA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Riyadh",
    calendar: "gregory",
    numberingSystem: "latn",
  }).format(d);
}

/** تنسيق تاريخ فقط (بلا وقت). */
export function formatDayAr(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("ar-SA", {
    dateStyle: "long",
    timeZone: "Asia/Riyadh",
    calendar: "gregory",
    numberingSystem: "latn",
  }).format(d);
}

/**
 * يحوّل مدى التسليم بالأيام إلى نص عربي واضح للعميل.
 * الوضوح هنا مقصود: مدد الشحن من الصين طويلة، وإخفاؤها يرفع نسبة المرتجعات.
 */
export function deliveryEstimateAr(
  minDays: number | null,
  maxDays: number | null,
): string {
  if (minDays == null && maxDays == null) return "مدة التسليم غير محددة";
  if (minDays != null && maxDays != null) {
    return `${minDays}–${maxDays} يوم عمل`;
  }
  return `حتى ${maxDays ?? minDays} يوم عمل`;
}
