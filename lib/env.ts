import { isIP } from "node:net";
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

const httpUrl = (label: string) =>
  z.url().refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === ""
    );
  }, `${label} يجب أن يستخدم http أو https بلا بيانات اعتماد أو fragment`);

const databaseUrl = z.string().min(1, "DATABASE_URL مطلوب").refine((value) => {
  try {
    return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "DATABASE_URL يجب أن يكون رابط PostgreSQL صالحًا");

const smtpUrl = z.string().refine((value) => {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return (
      ["smtp:", "smtps:"].includes(parsed.protocol) &&
      Boolean(parsed.hostname) &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}, "SMTP_URL يجب أن يكون رابط smtp أو smtps صالحًا");

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /change[-_ ]?me|replace[-_ ]?me|example|placeholder|your[-_ ]/.test(normalized) ||
    /^(0+|x+|test|secret|password)$/.test(normalized)
  );
}

function isValidProxyRange(value: string): boolean {
  const [address, prefix, ...extra] = value.split("/");
  const version = isIP(address ?? "");
  if (version === 0 || extra.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

const serverSchema = z.object({
  DATABASE_URL: databaseUrl,
  DB_POOL_MAX: decimalString("DB_POOL_MAX")
    .pipe(z.number().int().min(1).max(20))
    .default(5),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET يجب ألا يقل عن 32 حرفًا (ولّده بـ: openssl rand -base64 32)"),
  BETTER_AUTH_URL: httpUrl("BETTER_AUTH_URL").default("http://localhost:3000"),

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
  AE_API_BASE_URL: httpUrl("AE_API_BASE_URL").default("https://api-sg.aliexpress.com/rest"),
  AE_APP_KEY: z.string().default(""),
  AE_APP_SECRET: z.string().default(""),
  AE_ACCESS_TOKEN: z.string().default(""),
  AE_REFRESH_TOKEN: z.string().default(""),
  /** مفتاح AES-256 (base64/base64url) لتشفير رموز AliExpress في القاعدة. */
  AE_TOKEN_ENCRYPTION_KEY: z.string().default(""),
  /**
   * يطلب من المنصة خصم ثمن الطلبية فور إنشائها (الحقل try_to_pay).
   * يبقى false حتى يُفوَّض الحساب كحساب دروبشيبينغ — ينص التوثيق صراحةً
   * على أن تفعيله بحساب غير مفوَّض يُفشل الطلبية.
   */
  AE_TRY_TO_PAY: booleanString.default(false),
  /** هامش تجديد رمز الوصول قبل انتهائه (بالثواني). */
  AE_TOKEN_REFRESH_SKEW_SECONDS: decimalString("AE_TOKEN_REFRESH_SKEW_SECONDS")
    .pipe(z.number().int().min(30).max(86_400))
    .default(300),
  /** مدة الاحتفاظ بسجل استدعاءات المنصة قبل حذفه دوريًا. */
  AE_API_LOG_RETENTION_DAYS: decimalString("AE_API_LOG_RETENTION_DAYS")
    .pipe(z.number().int().min(1).max(365))
    .default(30),
  /** أقصى ارتفاع في تكلفة المصدر بين checkout ولحظة الشراء الآلي. */
  AE_MAX_SOURCE_COST_INCREASE_PERCENT: decimalString(
    "AE_MAX_SOURCE_COST_INCREASE_PERCENT",
  )
    .pipe(z.number().min(0).max(25))
    .default(3),

  // --- السوق ---
  // محرّك الصرف والعناوين في هذا المشروع مخصوص بـ USD→SAR والسعودية؛
  // قبول رموز أخرى يوحي بدعم غير موجود ويُنتج أسعارًا صحيحة شكليًا وخاطئة ماليًا.
  AE_SOURCE_CURRENCY: z.literal("USD").default("USD"),
  STORE_CURRENCY: z.literal("SAR").default("SAR"),
  STORE_COUNTRY: z.literal("SA").default("SA"),
  STORE_LOCALE: z.string().default("ar_SA"),

  // --- الصرف والتسعير ---
  FX_USD_TO_SAR: decimalString("FX_USD_TO_SAR")
    .pipe(z.number().min(1).max(10))
    .default(3.75),
  FX_BUFFER_PERCENT: decimalString("FX_BUFFER_PERCENT")
    .pipe(z.number().min(0).max(50))
    .default(2),
  DEFAULT_MARGIN_PERCENT: decimalString("DEFAULT_MARGIN_PERCENT")
    .pipe(z.number().min(0).max(200))
    .default(35),
  VAT_PERCENT: decimalString("VAT_PERCENT")
    .pipe(z.number().min(0).max(100))
    .default(15),
  PRICE_ROUNDING: decimalString("PRICE_ROUNDING")
    .pipe(
      z
        .number()
        .min(0.01)
        .max(100)
        .refine(
          (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
          "PRICE_ROUNDING يجب أن يكون بدقة هللة كاملة",
        ),
    )
    .default(0.05),

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
  PAYMENT_EXPIRY_MINUTES: decimalString("PAYMENT_EXPIRY_MINUTES")
    .pipe(z.number().int().min(5).max(1_440))
    .default(30),

  // --- البريد --------------------------------------------------------
  /** console = يطبع الرسالة في السجل (تطوير). smtp و resend يرسلان فعليًا. */
  MAIL_PROVIDER: z.enum(["console", "smtp", "resend"]).default("console"),
  MAIL_FROM: z.email().default("no-reply@ae-ds-store.local"),
  MAIL_FROM_NAME: z
    .string()
    .max(100)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .default(""),
  /** رابط SMTP كامل: smtps://user:pass@host:465 */
  SMTP_URL: smtpUrl.default(""),
  RESEND_API_KEY: z.string().default(""),

  // --- المهام المجدولة ------------------------------------------------
  /**
   * سرّ يحمي /api/cron/*. فارغ = المسار معطَّل تمامًا في الإنتاج،
   * لأن مسارًا مجدولًا بلا حماية يتيح لأي زائر استنزاف حصة الاستدعاءات.
   */
  CRON_SECRET: z.string().default(""),

  // --- بيانات المنشأة (تظهر على الفاتورة الضريبية ورمز ZATCA) ----------
  STORE_LEGAL_NAME: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .default("متجر الوصل"),
  /** الرقم الضريبي — خمس عشرة خانة تبدأ بـ 3 وتنتهي بـ 3 وفق هيئة الزكاة. */
  STORE_VAT_NUMBER: z
    .string()
    .refine((value) => !value || /^3\d{13}3$/u.test(value))
    .default(""),
  STORE_CR_NUMBER: z
    .string()
    .trim()
    .max(64)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .default(""),
  /** العنوان العام للمتجر — يُستخدم في sitemap و robots والروابط داخل البريد. */
  STORE_PUBLIC_URL: httpUrl("STORE_PUBLIC_URL").default("http://localhost:3000"),
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
  const isProductionRuntime =
    !isBuildPhase && process.env.NODE_ENV === "production";

  if (isProductionRuntime) {
    const authUrl = new URL(env.BETTER_AUTH_URL);
    const publicUrl = new URL(env.STORE_PUBLIC_URL);
    if (authUrl.protocol !== "https:" || publicUrl.protocol !== "https:") {
      throw new Error(
        "BETTER_AUTH_URL وSTORE_PUBLIC_URL يجب أن يستخدما HTTPS في الإنتاج.",
      );
    }
    if (authUrl.origin !== publicUrl.origin) {
      throw new Error(
        "BETTER_AUTH_URL وSTORE_PUBLIC_URL يجب أن يشيرا إلى الأصل نفسه في هذا التطبيق.",
      );
    }
    if (
      authUrl.pathname !== "/" ||
      publicUrl.pathname !== "/" ||
      authUrl.search !== "" ||
      publicUrl.search !== ""
    ) {
      throw new Error(
        "BETTER_AUTH_URL وSTORE_PUBLIC_URL يجب أن يكونا أصلًا فقط بلا مسار أو query في الإنتاج.",
      );
    }
    if (looksLikePlaceholder(env.BETTER_AUTH_SECRET) || env.BETTER_AUTH_SECRET.length < 48) {
      throw new Error(
        "BETTER_AUTH_SECRET في الإنتاج يجب أن يكون عشوائيًا بطول 48 محرفًا على الأقل، لا قيمةً تجريبية.",
      );
    }
    if (!env.AUTH_REQUIRE_EMAIL_VERIFICATION) {
      throw new Error(
        "AUTH_REQUIRE_EMAIL_VERIFICATION=true مطلوب في الإنتاج لمنع الحسابات غير المتحققة.",
      );
    }

    const onVercel = process.env.VERCEL === "1";
    if (!onVercel && env.TRUSTED_PROXIES.length === 0) {
      throw new Error(
        "TRUSTED_PROXIES مطلوب في الإنتاج الذاتي؛ اضبط نطاقات البروكسي الفعلية وامنع الوصول المباشر إلى الأصل.",
      );
    }
    const invalidProxyRanges = env.TRUSTED_PROXIES.filter(
      (entry) => !isValidProxyRange(entry),
    );
    if (invalidProxyRanges.length > 0) {
      throw new Error("TRUSTED_PROXIES يحتوي عنوان IP أو CIDR غير صالح.");
    }
    if (
      env.TRUSTED_PROXIES.includes("0.0.0.0/0") ||
      env.TRUSTED_PROXIES.includes("::/0")
    ) {
      throw new Error("TRUSTED_PROXIES لا يجوز أن يثق بالإنترنت كله.");
    }

    const dbUrl = new URL(env.DATABASE_URL);
    const dbHost = dbUrl.hostname.toLowerCase();
    const localDatabase = ["localhost", "127.0.0.1", "::1"].includes(dbHost);
    const dbUser = decodeURIComponent(dbUrl.username).toLowerCase();
    if (!dbUser || !dbUrl.password) {
      throw new Error("DATABASE_URL في الإنتاج يجب أن يحتوي مستخدمًا وكلمة مرور مخصصين للتطبيق.");
    }
    if (["postgres", "rdsadmin", "cloudsqlsuperuser"].includes(dbUser)) {
      throw new Error(
        "لا يجوز تشغيل التطبيق بدور PostgreSQL إداري؛ أنشئ دورًا محدود الصلاحيات للتطبيق.",
      );
    }
    const sslMode = dbUrl.searchParams.get("sslmode")?.toLowerCase();
    if (!localDatabase && !["require", "verify-ca", "verify-full"].includes(sslMode ?? "")) {
      throw new Error(
        "اتصال PostgreSQL البعيد في الإنتاج يجب أن يحدد sslmode=require أو verify-ca أو verify-full.",
      );
    }

    if (env.MAIL_FROM.endsWith(".local")) {
      throw new Error("MAIL_FROM في الإنتاج يجب أن يكون عنوانًا عامًا قابلًا للتسليم.");
    }
  }

  // في الوضع الحقيقي لا معنى لغياب المفاتيح — نكشف الخطأ مبكرًا
  if (!isBuildPhase && env.AE_MODE === "live") {
    const missing = (
      [
        ["AE_APP_KEY", env.AE_APP_KEY],
        ["AE_APP_SECRET", env.AE_APP_SECRET],
        ["AE_TOKEN_ENCRYPTION_KEY", env.AE_TOKEN_ENCRYPTION_KEY],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missing.length > 0) {
      throw new Error(
        `AE_MODE=live لكن المفاتيح التالية غير مضبوطة: ${missing.join(", ")}`,
      );
    }
    if (new URL(env.AE_API_BASE_URL).protocol !== "https:") {
      throw new Error("AE_API_BASE_URL يجب أن يستخدم HTTPS عند AE_MODE=live");
    }
    if (
      isProductionRuntime &&
      new URL(env.AE_API_BASE_URL).hostname.toLowerCase().replace(/\.$/u, "") !==
        "api-sg.aliexpress.com"
    ) {
      throw new Error(
        "AE_API_BASE_URL في الإنتاج يجب أن يشير إلى api-sg.aliexpress.com المعتمد.",
      );
    }
    if ([env.AE_APP_KEY, env.AE_APP_SECRET].some(looksLikePlaceholder)) {
      throw new Error("مفاتيح AliExpress المضبوطة تبدو قيمًا تجريبية؛ استخدم مفاتيح الإنتاج الحقيقية.");
    }
  }

  if (env.AE_TOKEN_ENCRYPTION_KEY) {
    const keyBytes = Buffer.from(env.AE_TOKEN_ENCRYPTION_KEY, "base64url");
    if (
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(env.AE_TOKEN_ENCRYPTION_KEY) ||
      keyBytes.length !== 32
    ) {
      throw new Error(
        "AE_TOKEN_ENCRYPTION_KEY يجب أن يكون 32 بايت مشفّرة base64/base64url (ولّده بـ openssl rand -base64 32).",
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
  if (!isBuildPhase && env.PAYMENT_PROVIDER !== "manual") {
    const providerSecret =
      env.PAYMENT_PROVIDER === "moyasar" ? env.MOYASAR_SECRET_KEY : env.TAP_SECRET_KEY;
    if (
      providerSecret.length < 24 ||
      env.PAYMENT_WEBHOOK_SECRET.length < 32 ||
      looksLikePlaceholder(providerSecret) ||
      looksLikePlaceholder(env.PAYMENT_WEBHOOK_SECRET)
    ) {
      throw new Error(
        `PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER} يتطلّب أسرار إنتاج قوية وغير تجريبية.`,
      );
    }
  }

  if (!isBuildPhase && env.PAYMENT_PROVIDER === "tap" && env.PAYMENT_EXPIRY_MINUTES > 60) {
    throw new Error(
      "PAYMENT_EXPIRY_MINUTES يجب أن يكون بين 5 و60 عند استخدام Tap.",
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
  if (isProductionRuntime && env.MAIL_PROVIDER === "console") {
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

  if (isProductionRuntime && env.MAIL_PROVIDER === "resend") {
    if (
      env.RESEND_API_KEY.length < 20 ||
      looksLikePlaceholder(env.RESEND_API_KEY)
    ) {
      throw new Error("RESEND_API_KEY في الإنتاج يبدو ضعيفًا أو تجريبيًا.");
    }
  }
  if (isProductionRuntime && env.MAIL_PROVIDER === "smtp") {
    const smtp = new URL(env.SMTP_URL);
    const smtpUser = decodeURIComponent(smtp.username);
    const smtpPassword = decodeURIComponent(smtp.password);
    if (
      (smtpUser && looksLikePlaceholder(smtpUser)) ||
      (smtpPassword && looksLikePlaceholder(smtpPassword))
    ) {
      throw new Error("بيانات اعتماد SMTP في الإنتاج تبدو تجريبية.");
    }
  }

  if (isProductionRuntime) {
    if (!env.CRON_SECRET) {
      throw new Error(
        "CRON_SECRET مطلوب في الإنتاج لأن طوابير التوريد والاسترداد تعتمد على المهمة المجدولة للاستدراك.",
      );
    }
    if (env.CRON_SECRET.length < 32 || looksLikePlaceholder(env.CRON_SECRET)) {
      throw new Error("CRON_SECRET في الإنتاج يجب أن يكون سرًا عشوائيًا بطول 32 محرفًا على الأقل.");
    }
  }

  if (isProductionRuntime) {
    const dbPassword = decodeURIComponent(new URL(env.DATABASE_URL).password);
    const smtpPassword = env.SMTP_URL
      ? decodeURIComponent(new URL(env.SMTP_URL).password)
      : "";
    const operationalSecrets = [
      ["DATABASE_URL password", dbPassword],
      ["BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET],
      ["AE_APP_SECRET", env.AE_APP_SECRET],
      ["AE_ACCESS_TOKEN", env.AE_ACCESS_TOKEN],
      ["AE_REFRESH_TOKEN", env.AE_REFRESH_TOKEN],
      ["AE_TOKEN_ENCRYPTION_KEY", env.AE_TOKEN_ENCRYPTION_KEY],
      ["MOYASAR_SECRET_KEY", env.MOYASAR_SECRET_KEY],
      ["TAP_SECRET_KEY", env.TAP_SECRET_KEY],
      ["PAYMENT_WEBHOOK_SECRET", env.PAYMENT_WEBHOOK_SECRET],
      ["RESEND_API_KEY", env.RESEND_API_KEY],
      ["SMTP password", smtpPassword],
      ["CRON_SECRET", env.CRON_SECRET],
    ] as const;

    for (let left = 0; left < operationalSecrets.length; left += 1) {
      const [leftName, leftValue] = operationalSecrets[left];
      if (!leftValue) continue;
      for (let right = left + 1; right < operationalSecrets.length; right += 1) {
        const [rightName, rightValue] = operationalSecrets[right];
        if (rightValue && leftValue === rightValue) {
          throw new Error(
            `${leftName} و${rightName} يجب أن يستخدما سرّين مستقلّين في الإنتاج.`,
          );
        }
      }
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
