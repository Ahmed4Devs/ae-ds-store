import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { hasAdminAssurance } from "@/lib/admin-access";
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

/**
 * هل الجلسة الحالية تملك صلاحية الإدارة كاملةً؟
 *
 * الدور وحده لا يكفي: يلزم بريد مؤكّد، وإعداد TOTP موثّق في قاعدة البيانات،
 * وطابع على **الجلسة الحالية** يثبت أنها أُنشئت بعد تحدّي العامل الثاني.
 * بذلك لا تكتسب الجلسات القديمة المسروقة صلاحية الإدارة عند تفعيل MFA لاحقًا.
 */
export const isAdmin = cache(async (): Promise<boolean> => {
  const session = await getSession();
  return hasAdminAssurance(session);
});

/**
 * حارس صفحات الإدارة — يُستدعى في مطلع **كل** صفحة تحت app/admin.
 *
 * ⚠️ لا يكفي حارس التخطيط (app/admin/layout.tsx) وحده. صرّح توثيق Next.js
 * نفسه بأن التخطيط «لا يُعاد رسمه عند التنقّل» و«لا يتحكّم فيما إذا كان بقية
 * المسار يُرسَم»: طلب RSC بشجرة موجَّهات مزوّرة تُطابق مقاطع الإدارة يجعل
 * الرّاسم يتخطّى التخطيط ويرسم الصفحة وحدها، فيتسرّب محتواها في حمولة RSC
 * بلا مرور بالتحقّق. كذلك مسؤول نُزعت صلاحيته وهو يتنقّل بين صفحات الإدارة
 * لا يُعاد فحصه. لذا يفحص كل صفحة نفسها.
 *
 * يعيد 404 لا 403: الردّ لا يؤكّد للمتطفّل وجود مسار إدارة أصلًا. وبفضل
 * cache() حول getSession لا تكلّف القراءة المكرّرة داخل الطلب الواحد شيئًا.
 */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) notFound();
}
