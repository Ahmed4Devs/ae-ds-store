import { env } from "@/lib/env";
import { AeApiError } from "./errors";

/**
 * مخزن رمز الوصول إلى منصة AliExpress.
 *
 * سبب وجوده: رمز الوصول **ينتهي ويُجدَّد في وقت التشغيل**، ومتغيّر البيئة
 * يُقرأ مرة واحدة عند الإقلاع ولا يستطيع الخادم تحديثه لنفسه. فكانت
 * النتيجة أن `AE_REFRESH_TOKEN` مضبوط في البيئة ولا يستعمله شيء، وأن
 * انتهاء الرمز يوقف كل توريد بصمت حتى ينتبه المشغّل ويحرّر ملف البيئة
 * ويعيد النشر. الآن يُخزَّن الرمز في صفّ واحد ويُجدَّد استباقيًا.
 *
 * قيمة `.env` لم تفقد معناها: تبقى **بذرة أولى** تُستورَد مرة واحدة إلى
 * الجدول (وتُستورَد يدويًا بعد ذلك من صفحة الإعدادات).
 */

/** المفتاح الثابت للصفّ الوحيد. */
const ROW_ID = "singleton";

/** مسار واجهة التجديد كما في المستند 834. authType = 0 فلا يحتاج رمز وصول. */
const REFRESH_API = "/auth/token/refresh";

/**
 * رمز وهمي في وضع المحاكاة.
 *
 * وضع المحاكاة **لا يلمس قاعدة البيانات** هنا عمدًا: الناقل يعود من فرع
 * المحاكاة قبل أن يطلب أي رمز، وسكربتات التحقق والبذر تعمل بلا مخطّط
 * جاهز في بعض الأحيان. ربط الرمز بقاعدة البيانات في هذا الوضع كان
 * سيحوّل `npm run verify:ae` من فحص مستقل إلى فحص يحتاج قاعدة.
 */
const MOCK_TOKEN = "mock-access-token";

export interface AeTokenState {
  present: boolean;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
  lastError: string | null;
  hasRefreshToken: boolean;
}

/** استيراد Prisma عند الحاجة فقط — يبقى هذا الملف قابلًا للتحميل بلا قاعدة. */
async function db() {
  const { prisma } = await import("@/lib/db");
  return prisma;
}

/**
 * وعد التجديد الجاري.
 *
 * الغرض منه منع «تدافع القطيع»: عند انتهاء الرمز تفشل عشرات الاستدعاءات
 * المتوازية في اللحظة نفسها فتطلب كلها تجديدًا. بعض خوادم OAuth تُبطل
 * الرمز السابق عند كل تجديد، فتُلغي المحاولات المتوازية تواقيع بعضها
 * ويبقى التطبيق عاطلًا. توحيد الوعد يجعل التجديد واحدًا ينتظره الجميع.
 *
 * يُحفظ على globalThis لا كمتغيّر وحدة: Next قد يحمّل الوحدة في أكثر من
 * نسخة (حزم مسارات منفصلة، إعادة تحميل التطوير)، فمتغيّر الوحدة يعطي وعدًا
 * لكل نسخة ويسقط الغرض داخل العملية الواحدة. (لا يمتدّ عبر النُّسخ الأفقية —
 * تلك تحرسها الكتابة الشرطية أدناه.)
 */
const REFRESH_SLOT = Symbol.for("ae-ds.token.refresh");
type RefreshGlobal = typeof globalThis & {
  [REFRESH_SLOT]?: Promise<RefreshOutcome> | null;
};
function getInFlight(): Promise<RefreshOutcome> | null {
  return (globalThis as RefreshGlobal)[REFRESH_SLOT] ?? null;
}
function setInFlight(p: Promise<RefreshOutcome> | null): void {
  (globalThis as RefreshGlobal)[REFRESH_SLOT] = p;
}

export type RefreshOutcome =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; message: string };

/** هل انتهى الرمز أو أوشك، وفق هامش الأمان المضبوط؟ */
function isStale(expiresAt: Date | null): boolean {
  if (!expiresAt) return false; // بلا تاريخ انتهاء لا نجدّد استباقيًا
  const skewMs = env().AE_TOKEN_REFRESH_SKEW_SECONDS * 1000;
  return expiresAt.getTime() - skewMs <= Date.now();
}

/**
 * الرمز الذي يجب أن يحمله الاستدعاء التالي.
 *
 * يجدّد استباقيًا حين يوشك الرمز على الانتهاء، فلا ننتظر خطأ
 * `IllegalAccessToken` لنكتشف ما كنّا نعرف موعده.
 */
export async function getAccessToken(): Promise<string> {
  if (env().AE_MODE === "mock") return MOCK_TOKEN;

  const prisma = await db();
  let row = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });

  // أول تشغيل بعد الترحيل: تُستورَد البذرة من البيئة تلقائيًا
  if (!row) {
    await seedTokenFromEnv();
    row = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
  }

  if (!row) return env().AE_ACCESS_TOKEN;

  if (isStale(row.expiresAt) && row.refreshToken) {
    const res = await refreshAccessToken();
    if (res.ok) {
      const fresh = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
      if (fresh) return fresh.accessToken;
    }
    // فشل التجديد: نعيد الرمز القائم ونترك المنصة تحكم عليه. ربما ما زال
    // صالحًا — الهامش احتياطي لا انتهاء فعلي.
  }

  return row.accessToken;
}

/**
 * يجدّد رمز الوصول عبر `/auth/token/refresh`.
 *
 * يمرّ بالناقل الموحّد `callAe` لا بـ fetch مباشر، فيبقى التوقيع والسجل
 * وحجب الأسرار وتصنيف الأخطاء كما هي لكل استدعاء آخر — ويظهر التجديد في
 * «سجل الواجهات» مثل غيره.
 */
export async function refreshAccessToken(): Promise<RefreshOutcome> {
  const existing = getInFlight();
  if (existing) return existing;
  const p = doRefresh().finally(() => setInFlight(null));
  setInFlight(p);
  return p;
}

async function doRefresh(): Promise<RefreshOutcome> {
  const prisma = await db();
  const row = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
  const refreshToken = row?.refreshToken || env().AE_REFRESH_TOKEN;

  if (!refreshToken) {
    const message =
      "لا يوجد رمز تجديد. اضبط AE_REFRESH_TOKEN واستورده، أو أعد التفويض من لوحة AliExpress.";
    await recordError(message);
    return { ok: false, message };
  }

  try {
    const { callAe } = await import("./client");
    const { data } = await callAe<AeRefreshResponse>(
      REFRESH_API,
      { refresh_token: refreshToken },
      // authType = 0 في التوثيق: هذه الواجهة تُصادق برمز التجديد نفسه،
      // فطلب رمز وصول صالح لتجديد رمز وصول منتهٍ حلقة لا تُغلق.
      { requiresAuth: false },
    );

    const accessToken = data.access_token;
    if (!accessToken) {
      const message = "استجابة التجديد لا تحمل رمز وصول.";
      await recordError(message);
      return { ok: false, message };
    }

    const expiresAt = resolveExpiry(data.expire_time, data.expires_in);
    const refreshExpiresAt = resolveExpiry(
      data.refresh_token_valid_time,
      data.refresh_expires_in,
    );

    const nextData = {
      accessToken,
      // المنصة تُدوّر رمز التجديد أحيانًا وتعيد واحدًا جديدًا — تجاهله
      // يعني أن التجديد القادم يفشل بعد انتهاء القديم.
      refreshToken: data.refresh_token || refreshToken,
      expiresAt,
      refreshExpiresAt,
      lastRefreshedAt: new Date(),
      lastError: null,
    };

    if (row) {
      /**
       * كتابة شرطية على رمز التجديد الذي أرسلناه فعلًا.
       *
       * عبر نُسختين أفقيتين قد تجدّد كلٌّ برمز RT0 نفسه: تُدوّره المنصة إلى
       * RT1 لإحداهما وتُبطل RT0، فلو كتبت الأخرى نتيجتها فوقها (آخر كاتب
       * يفوز) لَخزّنّا زوجًا ميتًا. الشرط `refreshToken = المُرسَل` يجعل أول
       * كتابة تنجح والثانية تُصيب صفرًا فتُهمَل بلا ضرر.
       */
      const written = await prisma.aeToken.updateMany({
        where: { id: ROW_ID, refreshToken },
        data: nextData,
      });
      if (written.count === 0) {
        // سبقنا تجديدٌ آخر بنجاح — رمزه أحدث، فلا نلمس ما كتبه.
        return { ok: true, expiresAt };
      }
    } else {
      await prisma.aeToken.create({ data: { id: ROW_ID, ...nextData } });
    }

    return { ok: true, expiresAt };
  } catch (e) {
    const message =
      e instanceof AeApiError
        ? `${e.code}: ${e.operatorMessage}`
        : e instanceof Error
          ? e.message
          : String(e);
    await recordError(message);
    return { ok: false, message };
  }
}

/**
 * يستورد الرمزين من متغيّرات البيئة إلى الجدول.
 * يعيد false إن كان `AE_ACCESS_TOKEN` فارغًا — فلا معنى لصفّ بلا رمز.
 */
export async function seedTokenFromEnv(): Promise<boolean> {
  const cfg = env();
  if (!cfg.AE_ACCESS_TOKEN) return false;

  const prisma = await db();
  await prisma.aeToken.upsert({
    where: { id: ROW_ID },
    create: {
      id: ROW_ID,
      accessToken: cfg.AE_ACCESS_TOKEN,
      refreshToken: cfg.AE_REFRESH_TOKEN || null,
      // البيئة لا تحمل تاريخ انتهاء، فنتركه فارغًا: لا تجديد استباقي حتى
      // يعرّفه أول تجديد فعلي، ويبقى التجديد التفاعلي عند خطأ التفويض.
      expiresAt: null,
      refreshExpiresAt: null,
      lastError: null,
    },
    update: {
      accessToken: cfg.AE_ACCESS_TOKEN,
      refreshToken: cfg.AE_REFRESH_TOKEN || null,
      lastError: null,
    },
  });
  return true;
}

/** حالة التفويض لعرضها في لوحة الإدارة. */
export async function getTokenState(): Promise<AeTokenState> {
  const prisma = await db();
  const row = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });

  if (!row) {
    return {
      present: false,
      expiresAt: null,
      refreshExpiresAt: null,
      lastRefreshedAt: null,
      lastError: null,
      hasRefreshToken: Boolean(env().AE_REFRESH_TOKEN),
    };
  }

  return {
    present: Boolean(row.accessToken),
    expiresAt: row.expiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    lastRefreshedAt: row.lastRefreshedAt,
    lastError: row.lastError,
    hasRefreshToken: Boolean(row.refreshToken),
  };
}

async function recordError(message: string): Promise<void> {
  try {
    const prisma = await db();
    await prisma.aeToken.updateMany({
      where: { id: ROW_ID },
      data: { lastError: message.slice(0, 500) },
    });
  } catch {
    // تسجيل سبب الفشل مساعد لا حرج — لا نُسقط التجديد بسببه
  }
}

/**
 * تعيد المنصة الانتهاء بشكلين: مطلقًا (`expire_time` بالمللي ثانية) ونسبيًا
 * (`expires_in` بالثواني). نفضّل المطلق حين يصل، لأن النسبي يُحسب من لحظة
 * الاستجابة فيزيد خطؤه بزمن الشبكة.
 */
function resolveExpiry(
  absoluteMs: number | undefined,
  relativeSeconds: number | undefined,
): Date | null {
  if (typeof absoluteMs === "number" && absoluteMs > 0) {
    return new Date(absoluteMs);
  }
  if (typeof relativeSeconds === "number" && relativeSeconds > 0) {
    return new Date(Date.now() + relativeSeconds * 1000);
  }
  return null;
}

interface AeRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  expire_time?: number;
  refresh_token_valid_time?: number;
}
