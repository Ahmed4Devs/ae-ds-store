"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LOCALE_COOKIE, LOCALES } from "@/lib/i18n";
import { THEME_COOKIE, THEMES } from "@/lib/theme";
import { BANNER_COOKIE } from "@/lib/banner";

/**
 * تفضيلات العرض — اللغة والمظهر.
 * تُخزَّن في كوكيز غير HttpOnly عمدًا: لا تحمل أي بيانات حسّاسة،
 * ويحتاجها سكربت المظهر في المتصفّح.
 */

const YEAR = 60 * 60 * 24 * 365;

const localeSchema = z.enum(LOCALES);
const themeSchema = z.enum(THEMES);

export async function setLocaleAction(value: string): Promise<void> {
  const parsed = localeSchema.safeParse(value);
  if (!parsed.success) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, parsed.data, {
    path: "/",
    maxAge: YEAR,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}

export async function setThemeAction(value: string): Promise<void> {
  const parsed = themeSchema.safeParse(value);
  if (!parsed.success) return;

  const store = await cookies();
  store.set(THEME_COOKIE, parsed.data, {
    path: "/",
    maxAge: YEAR,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}

/** يتذكّر إغلاق شريط الإعلان فلا يظهر ثانيةً. */
export async function dismissBannerAction(): Promise<void> {
  const store = await cookies();
  store.set(BANNER_COOKIE, "1", {
    path: "/",
    maxAge: YEAR,
    sameSite: "lax",
  });
}
