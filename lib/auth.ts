import { isIP } from "node:net";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { saudiPhoneSchema } from "@/lib/ksa";
import { safeErrorKind } from "@/lib/safe-log";
import {
  localeFromRequest,
  sendEmailVerificationMail,
  sendPasswordResetMail,
} from "@/lib/mail";

/**
 * إعداد المصادقة على الخادم.
 * البريد وكلمة المرور فقط — لا مزوّدي دخول خارجيين حتى لا نضيف
 * اعتماديات لا يحتاجها المتجر في مرحلته الأولى.
 */
/** أنماط المضيف المحلي المقبولة في التطوير. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const authEnv = env();
const isProduction = process.env.NODE_ENV === "production";
const isVercel = process.env.VERCEL === "1";
const isProductionBuild =
  process.env.NEXT_PHASE === "phase-production-build";

/**
 * Better Auth يمرّر الحقول الإضافية في التسجيل وتحديث المستخدم مباشرةً
 * إلى المحوّل. لذلك يجب ألا يكون تطبيع الجوال مسؤولية نموذج المتصفح وحده:
 * هذا المخطّط يُطبّق على كل create/update، بما فيها استدعاءات API المباشرة.
 * السلسلة الفارغة تُحوَّل إلى null لمسح الحقل الاختياري من صفحة الملف
 * الشخصي، فلا تتراكم قيم فارغة بصيغة ثالثة إلى جانب null والرقم المطبّع.
 */
const authPhoneInputSchema = z
  .string()
  .trim()
  .max(32, "رقم الجوال أطول من الحد المسموح")
  .transform((value) => (value === "" ? null : value))
  .pipe(z.union([z.null(), saudiPhoneSchema]));

function isValidProxyRange(value: string): boolean {
  const [address, prefix, ...extra] = value.split("/");
  const version = isIP(address ?? "");
  if (version === 0 || extra.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

/**
 * في الإنتاج لا نقبل إعدادًا يجعل عنوان العميل قابلًا للتزوير أو يعيد
 * استخدام سر المثال. تُتخطّى فحوص التشغيل وقت البناء لأن منصات النشر قد
 * تحقن الأسرار عند تشغيل الحاوية، لا أثناء next build.
 */
if (isProduction && !isProductionBuild) {
  if (new URL(authEnv.BETTER_AUTH_URL).protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL يجب أن يستخدم https في الإنتاج");
  }
  if (!isVercel && authEnv.TRUSTED_PROXIES.length === 0) {
    throw new Error(
      "TRUSTED_PROXIES مطلوب في الإنتاج خارج Vercel حتى لا يُستخلص IP المصادقة من ترويسة يكتبها العميل",
    );
  }
  const invalidProxies = authEnv.TRUSTED_PROXIES.filter(
    (proxy) => !isValidProxyRange(proxy),
  );
  if (invalidProxies.length > 0) {
    throw new Error(
      "TRUSTED_PROXIES يحتوي عنوان IP أو CIDR غير صالح",
    );
  }
  if (
    authEnv.TRUSTED_PROXIES.includes("0.0.0.0/0") ||
    authEnv.TRUSTED_PROXIES.includes("::/0")
  ) {
    throw new Error("TRUSTED_PROXIES لا يجوز أن يثق بالإنترنت كله");
  }
  if (
    authEnv.BETTER_AUTH_SECRET ===
    "dev-secret-change-me-in-production-min-32-chars"
  ) {
    throw new Error("BETTER_AUTH_SECRET ما زال يحمل قيمة المثال غير الآمنة");
  }
}

export const auth = betterAuth({
  appName: "Al-Wasl Store",
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: authEnv.BETTER_AUTH_SECRET,
  baseURL: authEnv.BETTER_AUTH_URL,

  // رسائل/وسائط مكتبة المصادقة قد تحمل تفاصيل قاعدة بيانات أو إدخالًا من
  // الطلب. نسجّل بطاقة مغلقة فقط، ونقصر الإنتاج على مستوى error.
  logger: {
    level: isProduction ? "error" : "warn",
    disableColors: true,
    log: (level, _message, ...args) => {
      const error = args.find((value): value is Error => value instanceof Error);
      const label = error ? safeErrorKind(error) : "AuthEvent";
      if (level === "error") console.error("[better-auth:error]", label);
      else console.warn(`[better-auth:${level}]`, label);
    },
  },

  /**
   * اربط إثبات العامل الثاني بالجلسة الجديدة نفسها، لا بالمستخدم فقط.
   *
   * عند نجاح تحدّي TOTP/رمز الاسترداد ينشئ Better Auth جلسة جديدة. وضع
   * الطابع هنا يعني أن الجلسات التي سبقت تفعيل MFA تظل بلا صلاحية إدارة،
   * حتى لو صار `twoFactorEnabled` صحيحًا على صف المستخدم لاحقًا.
   * `input: false` أدناه يمنع العميل من كتابة هذا الحقل بنفسه.
   */
  databaseHooks: {
    session: {
      create: {
        before: async (session, context) => ({
          data: {
            ...session,
            twoFactorVerifiedAt:
              context?.path === "/two-factor/verify-totp" ||
              context?.path === "/two-factor/verify-backup-code"
                ? new Date()
                : null,
          },
        }),
      },
    },
  },

  /**
   * التحقق من أصل الطلب حماية من تزوير الطلبات (CSRF).
   *
   * في التطوير نقبل أي منفذ محلي عمدًا: عندما يكون المنفذ 3000 مشغولًا
   * يختار Next تلقائيًا 3001 أو غيره، فيصبح الأصل مخالفًا لـ BETTER_AUTH_URL
   * ويُرفض تسجيل الدخول بالخطأ INVALID_ORIGIN دون سبب واضح للمطوّر.
   *
   * في الإنتاج يبقى التحقق صارمًا على العنوان المضبوط وحده.
   */
  trustedOrigins: (request) => {
    const configured = [authEnv.BETTER_AUTH_URL];
    if (isProduction) return configured;

    const origin = request?.headers.get("origin");
    if (origin && LOCAL_ORIGIN.test(origin)) configured.push(origin);

    return configured;
  },

  emailAndPassword: {
    enabled: true,
    // 12 محرفًا حدًّا أدنى — أطول من الافتراضي (8) لمقاومة التخمين
    minPasswordLength: 12,
    // يمنع كلمات مرور ضخمة من استنزاف دالة التجزئة والذاكرة.
    maxPasswordLength: 128,
    // إلزامي دائمًا في الإنتاج؛ المتغيّر يسمح بتشديد بيئات أخرى فقط.
    // lib/env.ts ترفض مزوّد console في الإنتاج وتتحقق من إعداد المرسل.
    requireEmailVerification:
      isProduction || authEnv.AUTH_REQUIRE_EMAIL_VERIFICATION,

    /**
     * إرسال رابط إعادة تعيين كلمة المرور.
     *
     * غيابه كان يعني أن من ينسى كلمته يفقد حسابه نهائيًا: لا مسار استعادة
     * في الواجهة، ولا مُرسِل بريد، مع قواعد خنق تحمي مسارًا غير موجود.
     */
    sendResetPassword: async ({ user, url }, request) => {
      await sendPasswordResetMail({
        to: user.email,
        name: user.name || user.email,
        url,
        locale: localeFromRequest(request),
      });
    },

    // الرابط صالح ساعة واحدة — الافتراضي نفسه، مثبَّت صراحةً لأنه وعدٌ
    // مكتوب في نصّ الرسالة ولا يصحّ أن يتغيّر بتغيّر الافتراضي.
    resetPasswordTokenExpiresIn: 3600,

    /**
     * إبطال الجلسات القائمة بعد تغيير كلمة المرور.
     *
     * إعادة التعيين تُستخدم غالبًا بعد اختراق حساب؛ وترك جلسات المهاجم
     * حيّة يُبطل الغرض من التغيير أصلًا.
     */
    revokeSessionsOnPasswordReset: true,
  },

  /**
   * تأكيد البريد — كتلة مستقلة لا حقل داخل emailAndPassword.
   *
   * (تفصيل يخصّ better-auth 1.7: `sendVerificationEmail` يعيش هنا،
   * بينما `sendResetPassword` يعيش داخل emailAndPassword أعلاه.)
   */
  emailVerification: {
    sendVerificationEmail: async ({ user, url }, request) => {
      await sendEmailVerificationMail({
        to: user.email,
        name: user.name || user.email,
        url,
        locale: localeFromRequest(request),
      });
    },
    sendOnSignUp: true,
    // لا نُسجّل الدخول تلقائيًا بعد التأكيد: الرابط قد يُفتح على جهاز
    // ليس جهاز صاحب الحساب (بريد مفتوح على حاسب مشترك).
    autoSignInAfterVerification: false,
    expiresIn: 3600 * 24,
  },

  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "CUSTOMER",
        input: false, // لا يستطيع المستخدم ترقية نفسه إلى مسؤول
      },
      phone: {
        type: "string",
        required: false,
        input: true,
        validator: {
          input: authPhoneInputSchema,
        },
      },
    },
  },

  session: {
    // نافذة أقصر تحدّ أثر سرقة كوكي الجلسة؛ تُجدّد كل 12 ساعة عند النشاط.
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 12,
    additionalFields: {
      twoFactorVerifiedAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },

  advanced: {
    cookiePrefix: "ae_ds",
    // كوكيز آمنة (Secure) في الإنتاج فقط — في التطوير على http تُكسر بغيرها
    useSecureCookies: isProduction,
    ipAddress: {
      trustedProxies: authEnv.TRUSTED_PROXIES,
      // Vercel يستبدل هذه الترويسة ولا يمرر قيمة كتبها العميل. خارج Vercel
      // لا نثق إلا بسلسلة X-Forwarded-For التي تنتهي ببروكسيات الإعداد.
      ipAddressHeaders: isVercel
        ? ["x-vercel-forwarded-for"]
        : ["x-forwarded-for"],
      /**
       * لا نعطّل تتبّع IP: Better Auth يتجاوز محدِّد المعدّل كليًا عند
       * disableIpTracking=true. خارج Vercel نفرض أعلاه قائمة بروكسيات
       * موثوقة؛ وعلى Vercel نستخدم ترويسته المحمية. إن تعذّر استخلاص IP
       * يبقى للمكتبة مفتاح مشترك آمن بدل إسقاط الحماية بصمت.
       */
      disableIpTracking: false,
    },
  },

  // لا توجد مزوّدات OAuth في هذا المتجر. تعطيل الربط صراحةً يمنع أن تؤدي
  // إضافة مزوّد لاحقًا إلى فتح تدفق دمج هويات دون مراجعة أمنية مستقلة.
  account: {
    accountLinking: {
      enabled: false,
      disableImplicitLinking: true,
    },
    // لا أثر اليوم لأن الحسابات credential فقط، لكنه يجعل أي رموز OAuth
    // مستقبلية مشفّرة افتراضيًا بدل نص صريح في PostgreSQL.
    encryptOAuthTokens: true,
  },

  /**
   * تحديد المعدّل — يمنع تخمين كلمات المرور وحشو بيانات الاعتماد.
   * الحدّ العام فضفاض، لكن مسارات المصادقة الحسّاسة مشدَّدة عبر customRules.
   * PostgreSQL هو المخزن المشترك والعمليات ذرّية في Better Auth 1.7، لذلك
   * لا يتيح التنقل بين نسخ serverless إعادة تصفير العدّاد. في الإنتاج لا
   * يبدأ الخادم إلا مع سلسلة بروكسي موثوقة، ويجب منع الوصول المباشر للأصل.
   */
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    /**
     * ملاحظتان على هذه القواعد:
     *
     * 1. المسار الصحيح هو `/request-password-reset`. كان مضبوطًا على
     *    `/forget-password` وهو مسار **لا وجود له** في نواة better-auth
     *    1.7 (الوحيد بهذا الاسم يقع في ملحق email-otp المهجور)، فكانت
     *    القاعدة تحمي عنوانًا لا يُستدعى أبدًا.
     *
     * 2. القاعدة المخصّصة **تستبدل** الافتراضية ولا تتراكم معها. لذلك لا
     *    نرفع سقف 3 للمسارات التي شدّدتها المكتبة، بل نوسّع نافذتها فقط.
     */
    customRules: {
      "/sign-in/email": { window: 60, max: 3 },
      "/sign-up/email": { window: 3600, max: 3 },
      "/request-password-reset": { window: 3600, max: 3 },
      "/reset-password": { window: 3600, max: 10 },
      "/send-verification-email": { window: 3600, max: 3 },
    },
  },

  plugins: [
    /**
     * TOTP فقط: السر ورموز الاسترداد مشفّرة، ولا يكتمل التفعيل قبل إدخال
     * رمز صالح. واجهة HTTP لدينا تمنع trustDevice حتى يمر كل دخول إداري
     * بعامل ثانٍ جديد، بينما يحمي القفل الموزّع الحساب من التخمين المتوازي.
     */
    twoFactor({
      issuer: "Al-Wasl Store",
      skipVerificationOnEnable: false,
      twoFactorCookieMaxAge: 5 * 60,
      trustDeviceMaxAge: 5 * 60,
      totpOptions: {
        digits: 6,
        period: 30,
      },
      backupCodeOptions: {
        amount: 10,
        length: 12,
        storeBackupCodes: "encrypted",
      },
      accountLockout: {
        enabled: true,
        maxFailedAttempts: 5,
        durationSeconds: 30 * 60,
      },
    }),

    // يجب أن يكون الأخير — يتيح ضبط الكوكيز من Server Actions
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
