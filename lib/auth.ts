import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

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
    minPasswordLength: 8,
    // لا نطلب تأكيد البريد في التطوير — فعّله قبل الإطلاق
    requireEmailVerification: false,
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
  },

  // يجب أن يكون الأخير — يتيح ضبط الكوكيز من Server Actions
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
