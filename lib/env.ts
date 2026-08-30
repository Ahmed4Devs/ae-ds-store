import { z } from "zod";

/**
 * تحقّق صارم من متغيّرات البيئة عند الإقلاع.
 * الفشل هنا أفضل بكثير من فشل غامض وقت الطلب.
 */

const decimalString = (label: string) =>
  z
    .string()
    .refine((v) => v.trim() !== "" && Number.isFinite(Number(v)), {
      message: `${label} يجب أن يكون رقمًا صالحًا`,
    })
    .transform(Number);

const serverSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL مطلوب"),

  BETTER_AUTH_SECRET: z
    .string()
    .min(16, "BETTER_AUTH_SECRET يجب ألا يقل عن 16 حرفًا"),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),

  // --- AliExpress ---
  AE_MODE: z.enum(["mock", "live"]).default("mock"),
  AE_API_BASE_URL: z.url().default("https://api-sg.aliexpress.com/rest"),
  AE_APP_KEY: z.string().default(""),
  AE_APP_SECRET: z.string().default(""),
  AE_ACCESS_TOKEN: z.string().default(""),
  AE_REFRESH_TOKEN: z.string().default(""),

  // --- السوق ---
  AE_SOURCE_CURRENCY: z.string().length(3).default("USD"),
  STORE_CURRENCY: z.string().length(3).default("SAR"),
  STORE_COUNTRY: z.string().length(2).default("SA"),
  STORE_LOCALE: z.string().default("ar_SA"),

  // --- الصرف والتسعير ---
  FX_USD_TO_SAR: decimalString("FX_USD_TO_SAR").default(3.75),
  FX_BUFFER_PERCENT: decimalString("FX_BUFFER_PERCENT").default(2),
  DEFAULT_MARGIN_PERCENT: decimalString("DEFAULT_MARGIN_PERCENT").default(35),
  VAT_PERCENT: decimalString("VAT_PERCENT").default(15),
  PRICE_ROUNDING: decimalString("PRICE_ROUNDING").default(0.05),
});

export type ServerEnv = z.infer<typeof serverSchema>;

function loadEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(جذر)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `فشل التحقق من متغيّرات البيئة:\n${issues}\n\nراجع ملف .env.example`,
    );
  }

  const env = parsed.data;

  // في الوضع الحقيقي لا معنى لغياب المفاتيح — نكشف الخطأ مبكرًا
  if (env.AE_MODE === "live") {
    const missing = (
      [
        ["AE_APP_KEY", env.AE_APP_KEY],
        ["AE_APP_SECRET", env.AE_APP_SECRET],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missing.length > 0) {
      throw new Error(
        `AE_MODE=live لكن المفاتيح التالية غير مضبوطة: ${missing.join(", ")}`,
      );
    }
  }

  return env;
}

let cached: ServerEnv | null = null;

/** متغيّرات البيئة المتحقَّق منها — للخادم فقط. */
export function env(): ServerEnv {
  cached ??= loadEnv();
  return cached;
}
