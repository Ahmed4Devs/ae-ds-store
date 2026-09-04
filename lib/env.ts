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

/** متغيّر بيئة منطقي — "true" أو "1" فقط تعني صحيحًا. */
const booleanString = z
  .string()
  .transform((v) => v.toLowerCase() === "true" || v === "1");

const serverSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL مطلوب"),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET يجب ألا يقل عن 32 حرفًا (ولّده بـ: openssl rand -base64 32)"),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),

  // يتطلب تأكيد البريد قبل إنشاء الجلسة (فعّله في الإنتاج مع مُرسِل بريد)
  AUTH_REQUIRE_EMAIL_VERIFICATION: booleanString.default(false),

  // عناوين البروكسي العكسي الموثوقة لاستخلاص عنوان العميل الحقيقي.
  // فارغة = لا نثق بترويسة X-Forwarded-For (الخادم مكشوف مباشرةً).
  TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),

  // --- AliExpress ---
  AE_MODE: z.enum(["mock", "live"]).default("mock"),
  AE_API_BASE_URL: z.url().default("https://api-sg.aliexpress.com/rest"),
  AE_APP_KEY: z.string().default(""),
  AE_APP_SECRET: z.string().default(""),
  AE_ACCESS_TOKEN: z.string().default(""),
  AE_REFRESH_TOKEN: z.string().default(""),
  /**
   * يطلب من المنصة خصم ثمن الطلبية فور إنشائها (الحقل try_to_pay).
   * يبقى false حتى يُفوَّض الحساب كحساب دروبشيبينغ — ينص التوثيق صراحةً
   * على أن تفعيله بحساب غير مفوَّض يُفشل الطلبية.
   */
  AE_TRY_TO_PAY: booleanString.default(false),
  /** هامش تجديد رمز الوصول قبل انتهائه (بالثواني). */
  AE_TOKEN_REFRESH_SKEW_SECONDS: decimalString("AE_TOKEN_REFRESH_SKEW_SECONDS").default(300),

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

  // --- الدفع ---------------------------------------------------------
  /**
   * مزوّد الدفع. `manual` وسيلة تطوير: تُنشأ نيّة دفع حقيقية بحالتها
   * وسجلّها، لكنها تُؤكَّد بإجراء إداري بدل بوابة خارجية — فيبقى المسار
   * نفسه الذي ستسلكه البوابة الحقيقية بلا فرع خاص في منطق الطلبيات.
   */
  PAYMENT_PROVIDER: z.enum(["manual", "moyasar", "tap"]).default("manual"),
  MOYASAR_SECRET_KEY: z.string().default(""),
  MOYASAR_PUBLISHABLE_KEY: z.string().default(""),
  TAP_SECRET_KEY: z.string().default(""),
  /** سرّ مشترك للتحقق من توقيع إشعارات المزوّد (webhook). */
  PAYMENT_WEBHOOK_SECRET: z.string().default(""),
  /** مهلة نيّة الدفع بالدقائق قبل اعتبارها منتهية. */
  PAYMENT_EXPIRY_MINUTES: decimalString("PAYMENT_EXPIRY_MINUTES").default(30),

  // --- البريد --------------------------------------------------------
  /** console = يطبع الرسالة في السجل (تطوير). smtp و resend يرسلان فعليًا. */
  MAIL_PROVIDER: z.enum(["console", "smtp", "resend"]).default("console"),
  MAIL_FROM: z.string().default("no-reply@ae-ds-store.local"),
  MAIL_FROM_NAME: z.string().default(""),
  /** رابط SMTP كامل: smtps://user:pass@host:465 */
  SMTP_URL: z.string().default(""),
  RESEND_API_KEY: z.string().default(""),

  // --- المهام المجدولة ------------------------------------------------
  /**
   * سرّ يحمي /api/cron/*. فارغ = المسار معطَّل تمامًا في الإنتاج،
   * لأن مسارًا مجدولًا بلا حماية يتيح لأي زائر استنزاف حصة الاستدعاءات.
   */
  CRON_SECRET: z.string().default(""),

  // --- بيانات المنشأة (تظهر على الفاتورة الضريبية ورمز ZATCA) ----------
  STORE_LEGAL_NAME: z.string().default("متجر الوصل"),
  /** الرقم الضريبي — خمس عشرة خانة تبدأ بـ 3 وتنتهي بـ 3 وفق هيئة الزكاة. */
  STORE_VAT_NUMBER: z.string().default(""),
  STORE_CR_NUMBER: z.string().default(""),
  /** العنوان العام للمتجر — يُستخدم في sitemap و robots والروابط داخل البريد. */
  STORE_PUBLIC_URL: z.url().default("http://localhost:3000"),
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

  /**
   * الفحوص التالية تخصّ **النشر** لا بنية البيئة: أسرار مزوّدين، عنوان
   * عام، مُرسِل بريد. تُتخطّى أثناء `next build` لأن هذه القيم قد تُحقَن في
   * وقت التشغيل فقط (كما في حاويات Docker)، فرفعُها خطأً وقت البناء يكسر
   * بناءً سليمًا. NEXT_PHASE تضبطها Next إلى phase-production-build أثناء
   * البناء وحده؛ وقت الخدمة الفعلية تختلف، فتسري الفحوص هناك.
   */
  const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

  // في الوضع الحقيقي لا معنى لغياب المفاتيح — نكشف الخطأ مبكرًا
  if (!isBuildPhase && env.AE_MODE === "live") {
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

  // اختيار مزوّد بلا مفتاحه يفشل عند أول عملية دفع — نكشفه عند الإقلاع.
  // ويلزم PAYMENT_WEBHOOK_SECRET أيضًا: بدونه تُرفض كل إشعارات المزوّد
  // (401) فلا تتأكّد أي دفعة وتتجمّد كل طلبية مدفوعة بمال حقيقي — عطلٌ
  // صامت لأن الإقلاع ينجح والدفع يبدو ناجحًا للعميل.
  const requiredFor: Record<string, ReadonlyArray<readonly [string, string]>> = {
    moyasar: [
      ["MOYASAR_SECRET_KEY", env.MOYASAR_SECRET_KEY],
      ["PAYMENT_WEBHOOK_SECRET", env.PAYMENT_WEBHOOK_SECRET],
    ],
    tap: [
      ["TAP_SECRET_KEY", env.TAP_SECRET_KEY],
      ["PAYMENT_WEBHOOK_SECRET", env.PAYMENT_WEBHOOK_SECRET],
    ],
  };
  const payMissing = (isBuildPhase ? [] : requiredFor[env.PAYMENT_PROVIDER] ?? [])
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (payMissing.length > 0) {
    throw new Error(
      `PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER} لكن المفاتيح التالية غير مضبوطة: ${payMissing.join(", ")}`,
    );
  }

  // العنوان العام على localhost مع بوابة حقيقية يكسر الدفع كليًّا: returnUrl
  // وعنوان الإشعار يصيران غير قابلين للوصول من خوادم المزوّد.
  if (!isBuildPhase && env.PAYMENT_PROVIDER !== "manual" && /localhost|127\.0\.0\.1/.test(env.STORE_PUBLIC_URL)) {
    throw new Error(
      `PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER} يتطلّب STORE_PUBLIC_URL عامًّا (لا localhost) — ` +
        "عنوان الإشعار والعودة يجب أن يصلهما المزوّد.",
    );
  }

  if (!isBuildPhase && env.MAIL_PROVIDER === "smtp" && !env.SMTP_URL) {
    throw new Error("MAIL_PROVIDER=smtp يتطلّب ضبط SMTP_URL");
  }
  if (!isBuildPhase && env.MAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
    throw new Error("MAIL_PROVIDER=resend يتطلّب ضبط RESEND_API_KEY");
  }

  // مزوّد console في الإنتاج لا يرسل شيئًا بل يطبع الرسالة — بما فيها روابط
  // إعادة تعيين كلمة المرور وتأكيد البريد، وهي رموز تفويض صالحة ساعةً/يومًا.
  // فتنتهي في سجلّات الإنتاج بينما تُخبر الواجهة العميل أن الرسالة أُرسلت:
  // بابُ استيلاء على الحسابات عبر من يقرأ السجلّات.
  if (!isBuildPhase && process.env.NODE_ENV === "production" && env.MAIL_PROVIDER === "console") {
    throw new Error(
      "MAIL_PROVIDER=console غير مسموح في الإنتاج — يطبع روابط الاستعادة في السجلّ. " +
        "اضبط smtp أو resend.",
    );
  }

  // تأكيد البريد بلا مُرسِل يقفل التسجيل على الجميع بصمت
  if (!isBuildPhase && env.AUTH_REQUIRE_EMAIL_VERIFICATION && env.MAIL_PROVIDER === "console") {
    throw new Error(
      "AUTH_REQUIRE_EMAIL_VERIFICATION=true مع MAIL_PROVIDER=console يعني رسائل تأكيد لا تصل أحدًا — " +
        "اضبط MAIL_PROVIDER=smtp أو resend، أو أوقف التأكيد.",
    );
  }

  return env;
}

let cached: ServerEnv | null = null;

/** متغيّرات البيئة المتحقَّق منها — للخادم فقط. */
export function env(): ServerEnv {
  cached ??= loadEnv();
  return cached;
}
