/** الصيغة العامة الوحيدة لرقم الطلب؛ لا تمرّر مدخل مسار حرّ إلى قاعدة البيانات. */
export const ORDER_NUMBER_PATTERN = /^AE-\d{8}-[0-9A-F]{6}$/u;

export function isOrderNumber(value: unknown): value is string {
  return typeof value === "string" && ORDER_NUMBER_PATTERN.test(value);
}
