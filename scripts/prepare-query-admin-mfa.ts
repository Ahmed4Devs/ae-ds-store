import "dotenv/config";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

/**
 * يُستخدم في CI فقط قبل verify:query. ينشئ TOTP على حساب البذر الإداري في
 * قاعدة اختبار محلية، ثم يطبع الرمز الآني وحده إلى stdout كي يلتقطه المشغّل
 * ويخفيه. لا يطبع URI أو السر أو رموز الاسترداد مطلقًا.
 */

function assertIsolatedLocalTestDatabase(): void {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.VERIFY_ADMIN_MFA_SETUP !== "true"
  ) {
    throw new Error("ADMIN_MFA_FIXTURE_GUARD");
  }

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("ADMIN_MFA_FIXTURE_DATABASE");
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const schema = url.searchParams.get("schema") ?? "public";
  const host = url.hostname.toLowerCase();
  const hasTestMarker = /(^|[-_])test($|[-_])/iu.test(`${database}_${schema}`);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host) ||
    !hasTestMarker
  ) {
    throw new Error("ADMIN_MFA_FIXTURE_TARGET");
  }
}

function sessionCookieFrom(response: Response): string | null {
  const setCookies = response.headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  if (setCookies.length === 0 && combined) setCookies.push(combined);

  for (const value of setCookies) {
    const match = value.match(
      /(?:^|,\s*)((?:__Secure-)?ae_ds\.session_token=[^;,\s]+)/u,
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

function decodeBase32Text(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];

  for (const char of value.replace(/=+$/u, "")) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("ADMIN_MFA_FIXTURE_BASE32");
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(output),
  );
}

async function main(): Promise<void> {
  assertIsolatedLocalTestDatabase();

  const email = process.env.VERIFY_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.VERIFY_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_MFA_FIXTURE_CREDENTIALS");

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      role: true,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  if (
    !user ||
    user.role !== "ADMIN" ||
    !user.emailVerified ||
    user.twoFactorEnabled
  ) {
    throw new Error("ADMIN_MFA_FIXTURE_USER");
  }

  const authOrigin = new URL(env().BETTER_AUTH_URL).origin;
  const baseHeaders = new Headers({
    origin: authOrigin,
    "x-forwarded-for": "127.0.0.1",
  });

  try {
    const signIn = await auth.api.signInEmail({
      body: { email, password },
      headers: baseHeaders,
      asResponse: true,
    });
    const sessionCookie = sessionCookieFrom(signIn);
    if (!signIn.ok || !sessionCookie) {
      throw new Error("ADMIN_MFA_FIXTURE_SIGN_IN");
    }

    const sessionHeaders = new Headers(baseHeaders);
    sessionHeaders.set("cookie", sessionCookie);
    const enrollment = await auth.api.enableTwoFactor({
      body: { password, method: "totp" },
      headers: sessionHeaders,
    });
    if (enrollment.method !== "totp") {
      throw new Error("ADMIN_MFA_FIXTURE_METHOD");
    }

    const totpUrl = new URL(enrollment.totpURI);
    const rawSecret = decodeBase32Text(
      totpUrl.searchParams.get("secret") ?? "",
    );
    const enrollmentCode = await auth.api.generateTOTP({
      body: { secret: rawSecret },
    });
    const verified = await auth.api.verifyTOTP({
      body: { code: enrollmentCode.code, trustDevice: false },
      headers: sessionHeaders,
      asResponse: true,
    });
    if (!verified.ok) throw new Error("ADMIN_MFA_FIXTURE_VERIFY");

    const stored = await prisma.twoFactor.findUnique({
      where: { userId: user.id },
      select: { verified: true },
    });
    if (!stored?.verified) throw new Error("ADMIN_MFA_FIXTURE_NOT_STORED");

    // verify:query يجب أن يثبت الدخول الكامل بنفسه، لا أن يرث جلسة التجهيز.
    await prisma.session.deleteMany({ where: { userId: user.id } });

    // ابدأ نافذة جديدة إن بقي أقل من عشرين ثانية. يقبل المحقق النافذة
    // السابقة أيضًا، فيبقى للاختبار خمسون ثانية على الأقل حتى في عامل CI
    // بطيء يترجم عدة Route Handlers قبل بلوغ خطوة دخول المسؤول.
    const remainingMs = 30_000 - (Date.now() % 30_000);
    if (remainingMs < 20_000) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remainingMs + 100);
      });
    }
    const currentCode = await auth.api.generateTOTP({
      body: { secret: rawSecret },
    });
    process.stdout.write(currentCode.code);
  } catch (error: unknown) {
    // الحارس أعلاه أثبت أن هذا fixture بدأ بلا MFA وبلا جلسات من seed.
    // ننظف دائمًا لأن Better Auth قد يكتب الصف ثم يرمي قبل عودة enable().
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { userId: user.id } }),
      prisma.twoFactor.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: false },
      }),
    ]).catch(() => undefined);
    throw error;
  }
}

main()
  .catch(() => {
    console.error("ADMIN_MFA_FIXTURE_FAILED");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
