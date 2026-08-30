import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "@/lib/auth";

/**
 * قراءة الجلسة على الخادم.
 *
 * ملاحظة Next.js 16: دالة headers() غير متزامنة — الوصول المتزامن أُزيل
 * نهائيًا في هذا الإصدار.
 *
 * مغلّفة بـ cache() حتى لا تتكرر القراءة في نفس الطلب عبر عدة مكوّنات.
 */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/** المستخدم الحالي أو null. */
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/** هل المستخدم الحالي مسؤول؟ */
export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  return (user as { role?: string } | null)?.role === "ADMIN";
}
