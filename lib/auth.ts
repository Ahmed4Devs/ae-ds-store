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
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: env().BETTER_AUTH_SECRET,
  baseURL: env().BETTER_AUTH_URL,

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
