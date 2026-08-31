import { dictionaries, type Dictionary } from "./dictionaries";

/**
 * الجزء المشترك من التعدّد اللغوي — **خالٍ من أي استيراد خاص بالخادم**.
 *
 * الفصل ضروري لا تجميلي: مكوّنات العميل تحتاج `fill` وأسماء اللغات،
 * ولو استوردتها من الوحدة التي تقرأ الكوكيز لسُحب `next/headers` إلى
 * حزمة المتصفّح وفشل البناء.
 */

export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ar";
export const LOCALE_COOKIE = "ae_ds_locale";

export const LOCALE_LABELS: Record<Locale, string> = {
  ar: "العربية",
  en: "English",
};

/** اتجاه الكتابة لكل لغة. */
export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** وسم اللغة الكامل المستخدم في تنسيق التواريخ والأرقام. */
export function bcp47(locale: Locale): string {
  return locale === "ar" ? "ar-SA" : "en-SA";
}

export function isLocale(v: string | undefined): v is Locale {
  return v === "ar" || v === "en";
}

/**
 * يستبدل العناصر النائبة {name} داخل نص مترجم.
 *
 * @example fill(t.cart.deliveryNote, { n: 32 })
 */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export type { Dictionary };
export { dictionaries };
