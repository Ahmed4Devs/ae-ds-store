"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  RESET_TOKEN_COOKIE,
  RESET_TOKEN_COOKIE_PATH,
  isResetToken,
} from "@/lib/reset-password-security";

const passwordSchema = z.string().min(12).max(128);

export interface ResetPasswordResult {
  ok: boolean;
}

/**
 * يستهلك الرمز على الخادم مباشرةً. لا يصل الرمز إلى JavaScript ولا إلى
 * React props/RSC؛ المتصفّح يرسل فقط كوكي HttpOnly المحصورة بهذا المسار.
 */
export async function resetPasswordWithCookie(
  newPassword: string,
): Promise<ResetPasswordResult> {
  const password = passwordSchema.safeParse(newPassword);
  const cookieStore = await cookies();
  const token = cookieStore.get(RESET_TOKEN_COOKIE)?.value;

  if (!password.success || !isResetToken(token)) return { ok: false };

  try {
    await auth.api.resetPassword({
      body: { newPassword: password.data, token },
    });

    // delete(name) قد يستخدم Path=/؛ نكتب تاريخًا منتهيًا بالمسار نفسه.
    cookieStore.set(RESET_TOKEN_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: RESET_TOKEN_COOKIE_PATH,
      expires: new Date(0),
    });
    return { ok: true };
  } catch {
    // رسالة واحدة للرمز المنتهي/المستهلك ولأي فشل، بلا كشف لتفاصيل الحساب.
    return { ok: false };
  }
}
