"use server";

import { revalidatePath } from "next/cache";
import { refreshAccessToken, seedTokenFromEnv } from "@/lib/aliexpress/token";
import { getDictionary } from "@/lib/i18n";
import { isAdmin } from "@/lib/session";

/**
 * إجراءات تفويض AliExpress.
 *
 * كل إجراء يتحقق من الصلاحية بنفسه لا اعتمادًا على حماية التخطيط، لأن
 * إجراءات الخادم قابلة للاستدعاء بطلب POST مباشر.
 */

export type TokenActionResult = { ok: boolean; message: string };

export async function refreshTokenAction(): Promise<TokenActionResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const res = await refreshAccessToken();
  revalidatePath("/admin/settings");

  return res.ok
    ? { ok: true, message: t.admin.tokenRefreshed }
    : { ok: false, message: res.message };
}

export async function seedTokenAction(): Promise<TokenActionResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const seeded = await seedTokenFromEnv();
  revalidatePath("/admin/settings");

  return seeded
    ? { ok: true, message: t.admin.tokenSeeded }
    : { ok: false, message: t.admin.tokenNoRefreshToken };
}
