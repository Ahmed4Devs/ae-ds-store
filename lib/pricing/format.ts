/**
 * أدوات عرض الأسعار الآمنة للمتصفح.
 *
 * هذا الملف لا يستورد متغيّرات البيئة أو أي وحدة خادمية، لذلك يمكن
 * لمكوّنات Client Components استخدامه دون سحب مخطّط الأسرار إلى الحزمة.
 */
export function formatSar(amount: number, locale: "ar" | "en" = "ar"): string {
  const tag = locale === "ar" ? "ar-SA-u-nu-latn" : "en-SA";
  return new Intl.NumberFormat(tag, {
    style: "currency",
    currency: "SAR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
