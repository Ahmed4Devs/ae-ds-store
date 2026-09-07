import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * يتحقق من أن الجلسة نفسها اجتازت العامل الثاني، لا أن حساب المستخدم يملك
 * TOTP فحسب. إبقاء الحارس هنا يضمن أن صفحات الإدارة ونقاط إدارة MFA تطبق
 * العقد نفسه ولا تنجرف إحداها إلى فحص الدور وحده.
 */
export async function hasAdminAssurance(
  session: AuthSession,
): Promise<boolean> {
  if (!session) return false;

  const user = session.user as typeof session.user & {
    role?: string;
    twoFactorEnabled?: boolean;
  };
  if (
    user.role !== "ADMIN" ||
    user.emailVerified !== true ||
    user.twoFactorEnabled !== true
  ) {
    return false;
  }

  const sessionRecord = session.session as typeof session.session & {
    twoFactorVerifiedAt?: Date | string | null;
  };
  if (!sessionRecord.twoFactorVerifiedAt) return false;

  const verifiedAt = new Date(sessionRecord.twoFactorVerifiedAt).getTime();
  const createdAt = new Date(sessionRecord.createdAt).getTime();
  if (
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(createdAt) ||
    verifiedAt < createdAt - 60_000 ||
    verifiedAt > createdAt + 60_000
  ) {
    return false;
  }

  const factor = await prisma.twoFactor.findUnique({
    where: { userId: user.id },
    select: { verified: true },
  });
  return factor?.verified === true;
}

/** حارس قابل للاستخدام من Route Handlers التي تملك Headers صريحة. */
export async function hasAdminAssuranceForHeaders(
  requestHeaders: Headers,
): Promise<boolean> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  return hasAdminAssurance(session);
}
