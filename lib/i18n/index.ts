import { cookies } from "next/headers";
import { cache } from "react";
import { dictionaries, type Dictionary } from "./dictionaries";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "./shared";

/**
 * التعدّد اللغوي — الجزء الخادمي.
 *
 * اختيار التصميم: اللغة تُخزَّن في كوكي بدل مقطع في المسار (/ar/ · /en/).
 * السبب أن التبديل هنا تفضيل شخصي يُختار مرة واحدة، وسلوك المتجر لا يتغيّر
 * بتغيّر اللغة. المقايضة معروفة: لا روابط منفصلة لكل لغة لأغراض SEO —
 * وإن لزم ذلك لاحقًا فالترقية تكون بنقل app/* إلى app/[locale]/* مع
 * الإبقاء على القواميس كما هي.
 *
 * ملاحظة على الحماية: الفصل بين هذه الوحدة و`shared.ts` هو ما يمنع تسرّب
 * `next/headers` إلى حزمة المتصفّح — أي استيراد لها من مكوّن عميل يفشل
 * البناء صراحةً. ولا تُستخدم حزمة `server-only` هنا لأنها ترمي استثناءً
 * في سكربتات Node العادية (سكربتات التحقق والبذر) وهي استخدامات مشروعة.
 */

/** اللغة الحالية من الكوكي. */
export const getLocale = cache(async (): Promise<Locale> => {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
});

/** قاموس اللغة الحالية. */
export const getDictionary = cache(async (): Promise<Dictionary> => {
  return dictionaries[await getLocale()];
});

// إعادة تصدير الجزء المشترك حتى تستورد مكوّنات الخادم من مكان واحد
export {
  bcp47,
  DEFAULT_LOCALE,
  dictionaries,
  dirFor,
  fill,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  LOCALES,
  type Dictionary,
  type Locale,
} from "./shared";
