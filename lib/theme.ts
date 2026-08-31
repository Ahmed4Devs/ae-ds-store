import { cookies } from "next/headers";
import { cache } from "react";

/**
 * المظهر — فاتح أو داكن أو تابع لإعداد النظام.
 *
 * تُخزَّن القيمة في كوكي تُقرأ على الخادم، فتُرسم السمة الصحيحة على عنصر
 * html من أول استجابة. البديل (القراءة من localStorage في المتصفّح) يسبّب
 * وميضًا بلون خاطئ قبل تنفيذ الشيفرة.
 */

export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "system";
export const THEME_COOKIE = "ae_ds_theme";

export function isTheme(v: string | undefined): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

export const getTheme = cache(async (): Promise<Theme> => {
  const store = await cookies();
  const raw = store.get(THEME_COOKIE)?.value;
  return isTheme(raw) ? raw : DEFAULT_THEME;
});

/**
 * سكربت صغير يُحقن في <head>.
 *
 * وظيفته الوحيدة: حين يكون الاختيار "تلقائي" يضبط data-theme وفق تفضيل
 * النظام قبل رسم الصفحة. لا يمكن للخادم معرفة تفضيل النظام، وبدون هذا
 * السطر يظهر الوضع الفاتح لحظةً لمستخدمي الوضع الداكن.
 */
export const THEME_SCRIPT = `
(function(){try{
  var d=document.documentElement;
  if(d.dataset.themeChoice==='system'){
    var dark=window.matchMedia('(prefers-color-scheme: dark)').matches;
    d.setAttribute('data-theme', dark?'dark':'light');
  }
}catch(e){}})();
`.trim();
