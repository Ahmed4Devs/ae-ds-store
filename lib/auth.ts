import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
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

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: env().BETTER_AUTH_SECRET,
  baseURL: env().BETTER_AUTH_URL,

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
    const configured = [env().BETTER_AUTH_URL];
    if (process.env.NODE_ENV === "production") return configured;

    const origin = request?.headers.get("origin");
    if (origin && LOCAL_ORIGIN.test(origin)) configured.push(origin);

    return configured;
  },

  emailAndPassword: {
    enabled: true,
    // 12 محرفًا حدًّا أدنى — أطول من الافتراضي (8) لمقاومة التخمين
    minPasswordLength: 12,
    // يُفعَّل عبر AUTH_REQUIRE_EMAIL_VERIFICATION=true في الإنتاج.
    // تتحقق lib/env.ts من وجود مُرسِل بريد فعلي قبل السماح بتفعيله، لأن
    // تفعيله بلا مُرسِل يقفل تسجيل الدخول على الجميع بصمت.
    requireEmailVerification: env().AUTH_REQUIRE_EMAIL_VERIFICATION,

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
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 يومًا
    updateAge: 60 * 60 * 24, // تجديد يومي
  },

  advanced: {
    cookiePrefix: "ae_ds",
    // كوكيز آمنة (Secure) في الإنتاج فقط — في التطوير على http تُكسر بغيرها
    useSecureCookies: process.env.NODE_ENV === "production",
    ipAddress: {
      trustedProxies: env().TRUSTED_PROXIES,
      /**
       * ⚠️ قائمة فارغة **لا** تعني تجاهل X-Forwarded-For.
       *
       * كان التعليق هنا يقول ذلك، والواقع عكسه: مع قائمة فارغة يمضي
       * `getIPFromHeader` إلى ما بعدها ويقبل ترويسةً ذات عنوان **واحد**
       * كما هي. فيكفي أن يرسل المهاجم `X-Forwarded-For: 1.2.3.4` ويبدّل
       * الرقم ليحصل على سلّة خنق جديدة عند كل طلب — أي تجاوزٌ كاملٌ
       * لحدود تسجيل الدخول بترويسة يكتبها بنفسه.
       *
       * فحين لا يوجد بروكسي موثوق نُعطّل تتبّع العنوان صراحةً، فيسقط
       * الخنق إلى مفتاح لا يستطيع العميل تزويره.
       */
      disableIpTracking: env().TRUSTED_PROXIES.length === 0,
    },
  },

  /**
   * تحديد المعدّل — يمنع تخمين كلمات المرور وحشو بيانات الاعتماد.
   * الحدّ العام فضفاض، لكن مسارات المصادقة الحسّاسة مشدَّدة عبر customRules.
   * لأن X-Forwarded-For لم يعد موثوقًا (أعلاه)، يعود المفتاح إلى عنوان
   * الاتصال الحقيقي فيتعذّر تجاوز الحدّ بتزوير الترويسة.
   */
  rateLimit: {
    enabled: true,
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
     * 2. تُطبَّق قواعد المكتبة الافتراضية أولًا ثم هذه، فالقيمة هنا
     *    **تُخفِّف** الافتراضي لا تُشدّده. الافتراضي يسمح بثلاثة طلبات
     *    في الدقيقة لمسارَي الاستعادة والتأكيد، فنُبقي أرقامنا عند
     *    نافذة أوسع وسقف مماثل حتى لا نفتح ما أغلقته المكتبة.
     */
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 3600, max: 5 },
      "/request-password-reset": { window: 3600, max: 5 },
      "/reset-password": { window: 3600, max: 10 },
      "/send-verification-email": { window: 3600, max: 5 },
    },
  },

  // يجب أن يكون الأخير — يتيح ضبط الكوكيز من Server Actions
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
