import "dotenv/config";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { POST as authRoutePost } from "@/app/api/auth/[...all]/route";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

/**
 * فحص تكاملي للمصادقة على قاعدة اختبار معزولة فقط.
 *
 * الحساب عابر وعشوائي، ويُحذف مع جلساته بعلاقة cascade في finally. الحراس
 * الثلاثة أدناه تمنع تشغيل الفحص مصادفةً على قاعدة تطوير أو إنتاج.
 */

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
    return;
  }

  failed++;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

function assertIsolatedTestDatabase(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("verify:auth يتطلب NODE_ENV=test");
  }
  if (process.env.AUTH_VERIFY_TEST_DB !== "true") {
    throw new Error(
      "verify:auth يتطلب AUTH_VERIFY_TEST_DB=true كتأكيد صريح لقاعدة الاختبار",
    );
  }
  if ((process.env.MAIL_PROVIDER ?? "console") !== "console") {
    throw new Error(
      "verify:auth يتطلب MAIL_PROVIDER=console حتى لا يرسل بريدًا خارجيًا",
    );
  }

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL مطلوب");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL غير صالح");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const schema = url.searchParams.get("schema") ?? "";
  const testMarker = /(^|[-_])test($|[-_])/i;
  if (!testMarker.test(database) && !testMarker.test(schema)) {
    throw new Error(
      "اسم قاعدة DATABASE_URL أو مخططها يجب أن يحمل مقطع test مستقلًا",
    );
  }
}

async function responseStatus(operation: () => Promise<Response>): Promise<number> {
  try {
    return (await operation()).status;
  } catch (error: unknown) {
    const status = (error as { status?: unknown; statusCode?: unknown })?.status;
    const statusCode = (error as { statusCode?: unknown })?.statusCode;
    if (typeof status === "number") return status;
    if (typeof statusCode === "number") return statusCode;
    throw error;
  }
}

function cookiePairFrom(response: Response, suffix: string): string | null {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = headers.getSetCookie?.() ?? [];
  const combined = response.headers.get("set-cookie");
  if (setCookies.length === 0 && combined) setCookies.push(combined);

  for (const value of setCookies) {
    const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = value.match(
      new RegExp(
        `(?:^|,\\s*)((?:__Secure-)?ae_ds\\.${escapedSuffix}=[^;,\\s]+)`,
      ),
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

function sessionCookieFrom(response: Response): string | null {
  return cookiePairFrom(response, "session_token");
}

/** يفك Base32 القياسي في TOTP URI إلى السر النصي الذي ولّدته المكتبة. */
function decodeBase32Text(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];

  for (const char of value.replace(/=+$/u, "")) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("TOTP URI يحمل Base32 غير صالح");
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
  assertIsolatedTestDatabase();

  const runId = randomUUID();
  const email = `auth-check-${runId}@example.invalid`;
  const invalidPhoneEmail = `auth-invalid-phone-${runId}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  const wrongPassword = randomBytes(32).toString("base64url");
  const name = `Auth verification ${runId}`;
  const ipBytes = randomBytes(2);
  const testIp = `198.18.${ipBytes[0]}.${ipBytes[1]}`;
  const ipHeader =
    process.env.VERCEL === "1"
      ? "x-vercel-forwarded-for"
      : "x-forwarded-for";
  const requestHeaders = new Headers({ [ipHeader]: testIp });
  const rateLimitEmail = `rate-${runId}@example.invalid`;
  const rateLimitIps = Array.from(
    { length: 12 },
    (_, index) => `198.19.${ipBytes[0]}.${(ipBytes[1] + index) % 256}`,
  );
  const authEnv = env();
  const authOrigin = new URL(authEnv.BETTER_AUTH_URL).origin;
  const signInUrl = new URL(
    "/api/auth/sign-in/email",
    authEnv.BETTER_AUTH_URL,
  ).toString();
  const enableTwoFactorUrl = new URL(
    "/api/auth/two-factor/enable",
    authEnv.BETTER_AUTH_URL,
  ).toString();
  const verifyTwoFactorUrl = new URL(
    "/api/auth/two-factor/verify-totp",
    authEnv.BETTER_AUTH_URL,
  ).toString();
  const getTotpUriUrl = new URL(
    "/api/auth/two-factor/get-totp-uri",
    authEnv.BETTER_AUTH_URL,
  ).toString();
  const disableTwoFactorUrl = new URL(
    "/api/auth/two-factor/disable",
    authEnv.BETTER_AUTH_URL,
  ).toString();
  const generateBackupCodesUrl = new URL(
    "/api/auth/two-factor/generate-backup-codes",
    authEnv.BETTER_AUTH_URL,
  ).toString();
  const emailLimitDigest = createHmac(
    "sha256",
    authEnv.BETTER_AUTH_SECRET,
  )
    .update(`/sign-in/email\0${rateLimitEmail}`)
    .digest("base64url");
  const testRateLimitKeys = [
    `auth-email:v1:${emailLimitDigest}`,
    `${testIp}|/sign-up/email`,
    `${testIp}|/sign-in/email`,
    `${testIp}|/update-user`,
    ...rateLimitIps.map((ip) => `${ip}|/sign-in/email`),
  ];
  const startedAt = new Date();
  let createdUserId: string | null = null;
  let operationError: unknown;

  console.log("\n=== تحقّق المصادقة على قاعدة اختبار معزولة ===\n");

  try {
    const invalidPhoneStatus = await responseStatus(() =>
      auth.api.signUpEmail({
        body: {
          name,
          email: invalidPhoneEmail,
          password,
          phone: "0412345678",
        },
        headers: requestHeaders,
        asResponse: true,
      }),
    );
    check(
      "التسجيل يرفض جوالًا غير سعودي على الخادم",
      invalidPhoneStatus === 400,
      `HTTP ${invalidPhoneStatus}`,
    );
    const invalidPhoneUsers = await prisma.user.count({
      where: { email: invalidPhoneEmail },
    });
    check("الجوال المرفوض لا ينشئ مستخدمًا", invalidPhoneUsers === 0);

    const signup = await auth.api.signUpEmail({
      body: {
        name,
        email: email.toUpperCase(),
        password,
        phone: "+966 (51) 234-5678",
      },
      headers: requestHeaders,
    });
    createdUserId = signup.user.id;
    check("إنشاء حساب عابر ينجح", Boolean(createdUserId));

    const created = await prisma.user.findUnique({
      where: { id: createdUserId },
      include: { accounts: true },
    });
    check("الحساب العابر موجود وحده", created?.email === email);
    check(
      "البريد يُطبّع إلى lowercase قبل بلوغ قيد قاعدة البيانات",
      created?.email === email && created.email === created.email.toLowerCase(),
      created?.email,
    );
    check("الدور الافتراضي CUSTOMER", created?.role === "CUSTOMER");
    check(
      "التسجيل يطبّع الجوال سعوديًا على الخادم",
      created?.phone === "512345678",
      created?.phone ?? "null",
    );
    check(
      "سجل الاعتماد يحمل تجزئة لا كلمة المرور الأصلية",
      created?.accounts.some(
        (account) =>
          Boolean(account.password) && account.password !== password,
      ) ?? false,
    );

    // يعمل الفحص سواء كان تأكيد البريد مطلوبًا في بيئة الاختبار أم لا.
    await prisma.user.update({
      where: { id: createdUserId },
      // fixture إداري حتى تختبر بقية الحالة حارس الصلاحية الفعلي أيضًا.
      data: { emailVerified: true, role: "ADMIN" },
    });

    const goodResponse = await auth.api.signInEmail({
      body: { email, password },
      headers: requestHeaders,
      asResponse: true,
    });
    const goodStatus = goodResponse.status;
    check("كلمة المرور الصحيحة تُقبل", goodStatus === 200, `HTTP ${goodStatus}`);

    const sessionCookie = sessionCookieFrom(goodResponse);
    check("تسجيل الدخول يصدر كوكي جلسة للاختبار", Boolean(sessionCookie));
    if (sessionCookie) {
      const updateHeaders = new Headers(requestHeaders);
      updateHeaders.set("cookie", sessionCookie);
      updateHeaders.set("origin", authOrigin);

      const invalidUpdateStatus = await responseStatus(() =>
        auth.api.updateUser({
          body: { phone: "not-a-saudi-number" },
          headers: updateHeaders,
          asResponse: true,
        }),
      );
      check(
        "تحديث المستخدم يرفض جوالًا غير صالح على الخادم",
        invalidUpdateStatus === 400,
        `HTTP ${invalidUpdateStatus}`,
      );
      const afterInvalidUpdate = await prisma.user.findUnique({
        where: { id: createdUserId },
        select: { phone: true },
      });
      check(
        "التحديث المرفوض لا يغيّر الجوال",
        afterInvalidUpdate?.phone === "512345678",
      );

      const normalizedUpdateStatus = await responseStatus(() =>
        auth.api.updateUser({
          body: { phone: "00966 (55) 987-6543" },
          headers: updateHeaders,
          asResponse: true,
        }),
      );
      const afterNormalizedUpdate = await prisma.user.findUnique({
        where: { id: createdUserId },
        select: { phone: true },
      });
      check(
        "تحديث المستخدم يطبّع الجوال على الخادم",
        normalizedUpdateStatus === 200 &&
          afterNormalizedUpdate?.phone === "559876543",
        `HTTP ${normalizedUpdateStatus}; ${afterNormalizedUpdate?.phone ?? "null"}`,
      );

      const clearPhoneStatus = await responseStatus(() =>
        auth.api.updateUser({
          body: { phone: "   " },
          headers: updateHeaders,
          asResponse: true,
        }),
      );
      const afterClear = await prisma.user.findUnique({
        where: { id: createdUserId },
        select: { phone: true },
      });
      check(
        "مسح الجوال يحفظ null بدل قيمة فارغة",
        clearPhoneStatus === 200 && afterClear?.phone === null,
        `HTTP ${clearPhoneStatus}; ${String(afterClear?.phone)}`,
      );

      const issuerOverride = await authRoutePost(
        new Request(enableTwoFactorUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: authOrigin,
            [ipHeader]: testIp,
            cookie: sessionCookie,
          },
          body: JSON.stringify({
            password,
            method: "totp",
            issuer: "Attacker controlled issuer",
          }),
        }),
      );
      check(
        "واجهة MFA تمنع issuer يرسله العميل",
        issuerOverride.status === 400,
        `HTTP ${issuerOverride.status}`,
      );

      const trustedDevice = await authRoutePost(
        new Request(verifyTwoFactorUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: authOrigin,
            [ipHeader]: testIp,
          },
          body: JSON.stringify({ code: "000000", trustDevice: true }),
        }),
      );
      check(
        "واجهة MFA تمنع تجاوز الدخول عبر trusted-device",
        trustedDevice.status === 400,
        `HTTP ${trustedDevice.status}`,
      );

      const enrollment = await auth.api.enableTwoFactor({
        body: { password, method: "totp" },
        headers: updateHeaders,
      });
      check(
        "بدء تسجيل TOTP يعيد URI وعشرة رموز استرداد",
        enrollment.method === "totp" &&
          typeof enrollment.totpURI === "string" &&
          enrollment.backupCodes.length === 10,
      );

      if (enrollment.method === "totp") {
        const totpUrl = new URL(enrollment.totpURI);
        const encodedSecret = totpUrl.searchParams.get("secret") ?? "";
        const rawSecret = decodeBase32Text(encodedSecret);
        const firstBackupCode = enrollment.backupCodes[0];
        const storedBeforeVerification = await prisma.twoFactor.findUnique({
          where: { userId: createdUserId },
        });
        check(
          "سر TOTP ورموز الاسترداد لا تُخزّن كنص صريح",
          Boolean(
            storedBeforeVerification &&
              !storedBeforeVerification.verified &&
              !storedBeforeVerification.secret.includes(rawSecret) &&
              enrollment.backupCodes.every(
                (backupCode) =>
                  !storedBeforeVerification.backupCodes.includes(backupCode),
              ),
          ),
        );

        const enrollmentCode = await auth.api.generateTOTP({
          body: { secret: rawSecret },
        });
        const enrollmentResponse = await auth.api.verifyTOTP({
          body: { code: enrollmentCode.code, trustDevice: false },
          headers: updateHeaders,
          asResponse: true,
        });
        const rotatedSessionCookie = sessionCookieFrom(enrollmentResponse);
        check(
          "لا يكتمل تفعيل TOTP قبل إثبات أول رمز صالح",
          enrollmentResponse.status === 200 && Boolean(rotatedSessionCookie),
          `HTTP ${enrollmentResponse.status}`,
        );

        const enrolledUser = await prisma.user.findUnique({
          where: { id: createdUserId },
          select: { twoFactorEnabled: true },
        });
        const enrolledFactor = await prisma.twoFactor.findUnique({
          where: { userId: createdUserId },
          select: { verified: true },
        });
        const enrollmentSession = await prisma.session.findFirst({
          where: {
            userId: createdUserId,
            twoFactorVerifiedAt: { not: null },
          },
          orderBy: { createdAt: "desc" },
        });
        check(
          "جلسة التسجيل تحمل إثبات العامل الثاني الخاص بها",
          enrolledUser?.twoFactorEnabled === true &&
            enrolledFactor?.verified === true &&
            Boolean(enrollmentSession?.twoFactorVerifiedAt),
        );

        let hiddenUriStatus = 0;
        let disableStatus = 0;
        let unassuredRegenerationStatus = 0;
        if (rotatedSessionCookie && enrollmentSession?.twoFactorVerifiedAt) {
          const enrollmentHeaders = {
            "content-type": "application/json",
            origin: authOrigin,
            [ipHeader]: testIp,
            cookie: rotatedSessionCookie,
          };
          hiddenUriStatus = (
            await authRoutePost(
              new Request(getTotpUriUrl, {
                method: "POST",
                headers: enrollmentHeaders,
                body: JSON.stringify({ password }),
              }),
            )
          ).status;
          disableStatus = (
            await authRoutePost(
              new Request(disableTwoFactorUrl, {
                method: "POST",
                headers: enrollmentHeaders,
                body: JSON.stringify({ password }),
              }),
            )
          ).status;

          const assurance = enrollmentSession.twoFactorVerifiedAt;
          await prisma.session.update({
            where: { id: enrollmentSession.id },
            data: { twoFactorVerifiedAt: null },
          });
          try {
            unassuredRegenerationStatus = (
              await authRoutePost(
                new Request(generateBackupCodesUrl, {
                  method: "POST",
                  headers: enrollmentHeaders,
                  body: JSON.stringify({ password }),
                }),
              )
            ).status;
          } finally {
            await prisma.session.update({
              where: { id: enrollmentSession.id },
              data: { twoFactorVerifiedAt: assurance },
            });
          }
        }
        check(
          "واجهة MFA لا تكشف URI لسر TOTP المسجل",
          hiddenUriStatus === 404,
          `HTTP ${hiddenUriStatus}`,
        );
        check(
          "واجهة MFA لا تسمح بتعطيل العامل من جلسة ويب",
          disableStatus === 404,
          `HTTP ${disableStatus}`,
        );
        check(
          "إعادة رموز الاسترداد ترفض جلسة بلا إثبات العامل الثاني",
          unassuredRegenerationStatus === 403,
          `HTTP ${unassuredRegenerationStatus}`,
        );

        // لا تُستخدم جلسة التسجيل لاختبار الدخول: حذفها يثبت أن كلمة المرور
        // وحدها لا تُنشئ جلسة عندما يكون MFA مفعّلًا.
        await prisma.session.deleteMany({ where: { userId: createdUserId } });
        const challengeHeaders = new Headers({
          [ipHeader]: `198.18.${ipBytes[0]}.${(ipBytes[1] + 1) % 256}`,
        });
        const challengeResponse = await auth.api.signInEmail({
          body: { email, password },
          headers: challengeHeaders,
          asResponse: true,
        });
        const challengeBody = (await challengeResponse.clone().json()) as {
          twoFactorRedirect?: unknown;
          twoFactorMethods?: unknown;
        };
        const challengeCookie = cookiePairFrom(
          challengeResponse,
          "two_factor",
        );
        check(
          "كلمة المرور الصحيحة تتحول إلى تحدّي TOTP بلا جلسة",
          challengeBody.twoFactorRedirect === true &&
            Array.isArray(challengeBody.twoFactorMethods) &&
            challengeBody.twoFactorMethods.includes("totp") &&
            !sessionCookieFrom(challengeResponse) &&
            Boolean(challengeCookie) &&
            (await prisma.session.count({
              where: { userId: createdUserId },
            })) === 0,
        );

        if (challengeCookie) {
          const verificationHeaders = new Headers(challengeHeaders);
          verificationHeaders.set("cookie", challengeCookie);
          const signInCode = await auth.api.generateTOTP({
            body: { secret: rawSecret },
          });
          const verificationResponse = await auth.api.verifyTOTP({
            body: { code: signInCode.code, trustDevice: false },
            headers: verificationHeaders,
            asResponse: true,
          });
          const verifiedCookie = sessionCookieFrom(verificationResponse);
          const assuredSession = await prisma.session.findFirst({
            where: {
              userId: createdUserId,
              twoFactorVerifiedAt: { not: null },
            },
            orderBy: { createdAt: "desc" },
          });
          check(
            "تحدّي TOTP الناجح ينشئ جلسة موثقة فقط",
            verificationResponse.status === 200 &&
              Boolean(sessionCookieFrom(verificationResponse)) &&
              Boolean(assuredSession?.twoFactorVerifiedAt),
            `HTTP ${verificationResponse.status}`,
          );

          if (verifiedCookie) {
            const readSessionHeaders = new Headers(challengeHeaders);
            readSessionHeaders.set("cookie", verifiedCookie);
            const visibleSession = await auth.api.getSession({
              headers: readSessionHeaders,
            });
            const visibleAssurance = (
              visibleSession?.session as
                | { twoFactorVerifiedAt?: Date | string | null }
                | undefined
            )?.twoFactorVerifiedAt;
            check(
              "قراءة الجلسة على الخادم ترى إثبات العامل الثاني",
              Boolean(visibleAssurance),
            );
          }
        }

        if (firstBackupCode) {
          await prisma.session.deleteMany({ where: { userId: createdUserId } });
          const backupHeaders = new Headers({
            [ipHeader]: `198.18.${ipBytes[0]}.${(ipBytes[1] + 2) % 256}`,
          });
          const backupChallenge = await auth.api.signInEmail({
            body: { email, password },
            headers: backupHeaders,
            asResponse: true,
          });
          const backupChallengeCookie = cookiePairFrom(
            backupChallenge,
            "two_factor",
          );
          let backupStatus = 0;
          if (backupChallengeCookie) {
            backupHeaders.set("cookie", backupChallengeCookie);
            backupStatus = await responseStatus(() =>
              auth.api.verifyBackupCode({
                body: {
                  code: firstBackupCode,
                  trustDevice: false,
                  disableSession: false,
                },
                headers: backupHeaders,
                asResponse: true,
              }),
            );
          }
          check(
            "رمز الاسترداد ينشئ جلسة موثقة",
            backupStatus === 200 &&
              (await prisma.session.count({
                where: {
                  userId: createdUserId,
                  twoFactorVerifiedAt: { not: null },
                },
              })) === 1,
            `HTTP ${backupStatus}`,
          );

          await prisma.session.deleteMany({ where: { userId: createdUserId } });
          const replayHeaders = new Headers({
            [ipHeader]: `198.18.${ipBytes[0]}.${(ipBytes[1] + 3) % 256}`,
          });
          const replayChallenge = await auth.api.signInEmail({
            body: { email, password },
            headers: replayHeaders,
            asResponse: true,
          });
          const replayCookie = cookiePairFrom(replayChallenge, "two_factor");
          let replayStatus = 0;
          if (replayCookie) {
            replayHeaders.set("cookie", replayCookie);
            replayStatus = await responseStatus(() =>
              auth.api.verifyBackupCode({
                body: {
                  code: firstBackupCode,
                  trustDevice: false,
                  disableSession: false,
                },
                headers: replayHeaders,
                asResponse: true,
              }),
            );
          }
          check(
            "رمز الاسترداد المستهلك لا يقبل إعادة التشغيل",
            replayStatus === 401,
            `HTTP ${replayStatus}`,
          );
        }

        // أنشئ trusted-device قديمًا عبر API الخادم فقط كي نثبت أن غلاف HTTP
        // يتجاهله. هذا يحاكي كوكيًا سبق سياسة التطبيق الحالية ولا يفتح
        // trusted-device في المسار الذي يستطيع العميل استدعاءه.
        await prisma.session.deleteMany({ where: { userId: createdUserId } });
        const legacyHeaders = new Headers({
          [ipHeader]: `198.18.${ipBytes[0]}.${(ipBytes[1] + 4) % 256}`,
        });
        const legacyChallenge = await auth.api.signInEmail({
          body: { email, password },
          headers: legacyHeaders,
          asResponse: true,
        });
        const legacyChallengeCookie = cookiePairFrom(
          legacyChallenge,
          "two_factor",
        );
        let assuredCookie: string | null = null;
        let legacyTrustCookie: string | null = null;
        if (legacyChallengeCookie) {
          legacyHeaders.set("cookie", legacyChallengeCookie);
          const legacyCode = await auth.api.generateTOTP({
            body: { secret: rawSecret },
          });
          const legacyVerification = await auth.api.verifyTOTP({
            body: { code: legacyCode.code, trustDevice: true },
            headers: legacyHeaders,
            asResponse: true,
          });
          assuredCookie = sessionCookieFrom(legacyVerification);
          legacyTrustCookie = cookiePairFrom(
            legacyVerification,
            "trust_device",
          );
        }

        let assuredRegenerationStatus = 0;
        let regeneratedCodeCount = 0;
        if (assuredCookie) {
          const regenerationResponse = await authRoutePost(
            new Request(generateBackupCodesUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: authOrigin,
                [ipHeader]: testIp,
                cookie: assuredCookie,
              },
              body: JSON.stringify({ password }),
            }),
          );
          assuredRegenerationStatus = regenerationResponse.status;
          const regenerationBody = (await regenerationResponse.json()) as {
            backupCodes?: unknown;
          };
          regeneratedCodeCount = Array.isArray(regenerationBody.backupCodes)
            ? regenerationBody.backupCodes.length
            : 0;
        }
        check(
          "إعادة رموز الاسترداد تقبل جلسة مسؤول موثقة فقط",
          assuredRegenerationStatus === 200 && regeneratedCodeCount === 10,
          `HTTP ${assuredRegenerationStatus}; ${regeneratedCodeCount}`,
        );

        await prisma.session.deleteMany({ where: { userId: createdUserId } });
        let legacySignInRedirect = false;
        let legacySignInSessionCookie: string | null = null;
        if (legacyTrustCookie) {
          const legacySignIn = await authRoutePost(
            new Request(signInUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: authOrigin,
                [ipHeader]: testIp,
                cookie: legacyTrustCookie,
              },
              body: JSON.stringify({ email, password }),
            }),
          );
          const legacySignInBody = (await legacySignIn.clone().json()) as {
            twoFactorRedirect?: unknown;
          };
          legacySignInRedirect =
            legacySignIn.status === 200 &&
            legacySignInBody.twoFactorRedirect === true;
          legacySignInSessionCookie = sessionCookieFrom(legacySignIn);
        }
        check(
          "كوكي trusted-device قديم لا يتجاوز تحدّي TOTP",
          Boolean(legacyTrustCookie) &&
            legacySignInRedirect &&
            !legacySignInSessionCookie &&
            (await prisma.session.count({
              where: { userId: createdUserId },
            })) === 0,
        );
      }
    }

    const badStatus = await responseStatus(() =>
      auth.api.signInEmail({
        body: { email, password: wrongPassword },
        headers: requestHeaders,
        asResponse: true,
      }),
    );
    check(
      "كلمة مرور خاطئة تُرفض كخطأ عميل",
      badStatus === 400 || badStatus === 401,
      `HTTP ${badStatus}`,
    );

    const sessions = await prisma.session.count({
      where: { userId: createdUserId },
    });
    check(
      "إعادة رمز الاسترداد المرفوض لا تترك جلسة",
      sessions === 0,
      `${sessions}`,
    );

    const duplicateForm = await authRoutePost(
      new Request(signInUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "email=first%40example.invalid&email=second%40example.invalid",
      }),
    );
    check("صيغة form ذات email مكرر تُرفض", duplicateForm.status === 415);

    const oversized = await authRoutePost(
      new Request(signInUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: rateLimitEmail,
          password: "x".repeat(17_000),
        }),
      }),
    );
    check("جسم المصادقة الأكبر من الحد يُرفض", oversized.status === 413);

    const oversizedAgent = await authRoutePost(
      new Request(signInUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "A".repeat(513),
        },
        body: JSON.stringify({ email: rateLimitEmail, password: wrongPassword }),
      }),
    );
    check("User-Agent الشاذ لا يُخزّن في جلسة", oversizedAgent.status === 431);

    await prisma.rateLimit.deleteMany({
      where: { key: { in: testRateLimitKeys } },
    });
    const parallelStatuses = await Promise.all(
      rateLimitIps.map(async (ip) => {
        const response = await authRoutePost(
          new Request(signInUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: authOrigin,
              [ipHeader]: ip,
            },
            body: JSON.stringify({
              email: rateLimitEmail,
              password: "not-the-right-password-123",
            }),
          }),
        );
        return response.status;
      }),
    );
    const emailLimited = parallelStatuses.filter(
      (status) => status === 429,
    ).length;
    const reachedAuth = parallelStatuses.filter(
      (status) => status === 400 || status === 401,
    ).length;
    check(
      "حد البريد ذري تحت 12 محاولة متوازية",
      reachedAuth === 10 && emailLimited === 2,
      `auth=${reachedAuth} limited=${emailLimited}`,
    );
  } catch (error: unknown) {
    operationError = error;
  } finally {
    // إن فشل التسجيل بعد إنشاء الصف وقبل إعادة المعرّف، يبقى شرطا الاسم
    // والبريد العشوائيان وتاريخ التشغيل حاجزًا يمنع لمس بيانات سابقة.
    const deleted = createdUserId
      ? await prisma.user.deleteMany({
          where: {
            OR: [
              { id: createdUserId },
              {
                email: invalidPhoneEmail,
                name,
                createdAt: { gte: startedAt },
              },
            ],
          },
        })
      : await prisma.user.deleteMany({
          where: {
            email: { in: [email, invalidPhoneEmail] },
            name,
            createdAt: { gte: startedAt },
          },
        });

    check(
      "حُذف حساب الاختبار في finally",
      createdUserId
        ? deleted.count >= 1 && deleted.count <= 2
        : deleted.count <= 2,
    );
    if (createdUserId) {
      const leftoverSessions = await prisma.session.count({
        where: { userId: createdUserId },
      });
      check("لم تتبقَّ جلسات من الفحص", leftoverSessions === 0);
    }
    const leftoverUsers = await prisma.user.count({
      where: {
        email: { in: [email, invalidPhoneEmail] },
        name,
        createdAt: { gte: startedAt },
      },
    });
    check("لم يتبقَّ حساب عابر من الفحص", leftoverUsers === 0);

    await prisma.rateLimit.deleteMany({
      where: { key: { in: testRateLimitKeys } },
    });
    const leftoverRateLimits = await prisma.rateLimit.count({
      where: { key: { in: testRateLimitKeys } },
    });
    check(
      "نُظّفت عدادات المصادقة الخاصة بالفحص",
      leftoverRateLimits === 0,
      `${leftoverRateLimits}`,
    );
  }

  if (operationError) throw operationError;

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  نجح: ${passed}   |   فشل: ${failed}`);
  console.log(`${"═".repeat(50)}\n`);

  if (failed > 0) throw new Error(`فشل ${failed} من فحوص المصادقة`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "خطأ غير معروف";
    console.error(`فشل verify:auth: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
