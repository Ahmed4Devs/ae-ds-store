import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  secretEncryptionEnabled,
} from "@/lib/crypto/secrets";
import { safeErrorKind } from "@/lib/safe-log";
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

  const accessToken = decryptSecret(row.accessToken, "ae-access-token");
  const refreshToken = row.refreshToken
    ? decryptSecret(row.refreshToken, "ae-refresh-token")
    : null;

  // ترقية صامتة للصفوف القديمة المكتوبة بنص صريح. الشرط على القيم القديمة
  // يمنع أن نطغى على تجديد متزامن كتب رموزًا أحدث.
  if (
    secretEncryptionEnabled() &&
    (!isEncryptedSecret(row.accessToken) ||
      (row.refreshToken !== null && !isEncryptedSecret(row.refreshToken)))
  ) {
    await prisma.aeToken.updateMany({
      where: {
        id: ROW_ID,
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
      },
      data: {
        accessToken: encryptSecret(accessToken, "ae-access-token"),
        refreshToken: refreshToken
          ? encryptSecret(refreshToken, "ae-refresh-token")
          : null,
      },
    });
  }

  if (isStale(row.expiresAt) && refreshToken) {
    const res = await refreshAccessToken();
    if (res.ok) {
      const fresh = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
      if (fresh) {
        return decryptSecret(fresh.accessToken, "ae-access-token");
      }
    }
    // فشل التجديد: نعيد الرمز القائم ونترك المنصة تحكم عليه. ربما ما زال
    // صالحًا — الهامش احتياطي لا انتهاء فعلي.
  }

  return accessToken;
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
  const requestedAt = new Date();
  let row = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
  if (!row && (await seedTokenFromEnv())) {
    row = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
  }

  if (!row) {
    return { ok: false, message: "لا يوجد رمز وصول مخزّن لبدء التجديد." };
  }

  const leaseId = randomUUID();
  const leaseUntil = new Date(Date.now() + 45_000);
  const claimed = await prisma.aeToken.updateMany({
    where: {
      id: ROW_ID,
      OR: [
        { refreshLeaseUntil: null },
        { refreshLeaseUntil: { lt: new Date() } },
      ],
    },
    data: { refreshLeaseId: leaseId, refreshLeaseUntil: leaseUntil },
  });

  if (claimed.count === 0) {
    // نسخة أخرى تجدّد الآن. ننتظر مدة محدودة ثم نستخدم نتيجتها؛ لا نرسل
    // refresh token نفسه بالتوازي لأن بعض المزوّدين يبطله عند كل تدوير.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const fresh = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
      if (fresh && !fresh.refreshLeaseId && !isStale(fresh.expiresAt)) {
        return { ok: true, expiresAt: fresh.expiresAt };
      }
      if (fresh && !fresh.refreshLeaseId) {
        return {
          ok: false,
          message: fresh.lastError ?? "فشل تجديد الرمز في نسخة أخرى.",
        };
      }
    }
    return { ok: false, message: "تجديد رمز الوصول جارٍ في نسخة أخرى." };
  }

  // نعيد القراءة بعد امتلاك المزلاج؛ ربما جدّدت نسخة سابقة الرمز قبل أن
  // نأخذ المزلاج مباشرةً، فلا داعي لتدويره مرة أخرى.
  row = await prisma.aeToken.findUnique({ where: { id: ROW_ID } });
  if (!row || row.refreshLeaseId !== leaseId) {
    return { ok: false, message: "تعذّر امتلاك مزلاج تجديد الرمز." };
  }
  if (
    row.lastRefreshedAt &&
    row.lastRefreshedAt.getTime() >= requestedAt.getTime()
  ) {
    await releaseRefreshLease(leaseId);
    return { ok: true, expiresAt: row.expiresAt };
  }

  const storedRefreshToken = row?.refreshToken ?? null;
  try {
    // فك الرمز داخل كتلة الحماية كي يُحرَّر المزلاج حتى إذا تغيّر مفتاح
    // التشفير أو تلف ciphertext المخزّن.
    const refreshToken = storedRefreshToken
      ? decryptSecret(storedRefreshToken, "ae-refresh-token")
      : env().AE_REFRESH_TOKEN;

    if (!refreshToken) {
      const message =
        "لا يوجد رمز تجديد. اضبط AE_REFRESH_TOKEN واستورده، أو أعد التفويض من لوحة AliExpress.";
      await releaseRefreshLease(leaseId, message);
      return { ok: false, message };
    }

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
      await releaseRefreshLease(leaseId, message);
      return { ok: false, message };
    }

    const expiresAt = resolveExpiry(data.expire_time, data.expires_in);
    const refreshExpiresAt = resolveExpiry(
      data.refresh_token_valid_time,
      data.refresh_expires_in,
    );

    const nextData = {
      accessToken: encryptSecret(accessToken, "ae-access-token"),
      // المنصة تُدوّر رمز التجديد أحيانًا وتعيد واحدًا جديدًا — تجاهله
      // يعني أن التجديد القادم يفشل بعد انتهاء القديم.
      refreshToken: encryptSecret(
        data.refresh_token || refreshToken,
        "ae-refresh-token",
      ),
      expiresAt,
      refreshExpiresAt,
      lastRefreshedAt: new Date(),
      lastError: null,
      refreshLeaseId: null,
      refreshLeaseUntil: null,
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
        where: {
          id: ROW_ID,
          refreshToken: storedRefreshToken,
          refreshLeaseId: leaseId,
        },
        data: nextData,
      });
      if (written.count === 0) {
        // انتهت مهلة مزلاجنا أو استولت نسخة أخرى عليه. لا نزعم النجاح إلا
        // إذا كانت النسخة الأخرى قد خزّنت بالفعل رمزًا حديثًا.
        const current = await prisma.aeToken.findUnique({
          where: { id: ROW_ID },
          select: { expiresAt: true, lastRefreshedAt: true },
        });
        if (
          current?.lastRefreshedAt &&
          current.lastRefreshedAt.getTime() >= requestedAt.getTime()
        ) {
          return { ok: true, expiresAt: current.expiresAt };
        }
        return { ok: false, message: "فقدت العملية مزلاج تجديد الرمز." };
      }
    } else {
      await prisma.aeToken.create({ data: { id: ROW_ID, ...nextData } });
    }

    return { ok: true, expiresAt };
  } catch (e) {
    console.error("[ae-token] فشل تجديد الرمز:", safeErrorKind(e));
    const upstreamCode =
      e instanceof AeApiError && /^[A-Za-z0-9_. -]{1,64}$/.test(e.code)
        ? e.code
        : null;
    const message =
      upstreamCode === null
        ? "تعذّر تجديد رمز AliExpress بأمان."
        : `تعذّر تجديد رمز AliExpress (${upstreamCode}).`;
    await releaseRefreshLease(leaseId, message);
    return { ok: false, message };
  }
}

async function releaseRefreshLease(
  leaseId: string,
  errorMessage?: string,
): Promise<void> {
  try {
    const prisma = await db();
    await prisma.aeToken.updateMany({
      where: { id: ROW_ID, refreshLeaseId: leaseId },
      data: {
        refreshLeaseId: null,
        refreshLeaseUntil: null,
        ...(errorMessage ? { lastError: errorMessage.slice(0, 500) } : {}),
      },
    });
  } catch {
    // انتهاء المهلة يحرر المزلاج حتى لو فشل تنظيفه الفوري.
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
      accessToken: encryptSecret(cfg.AE_ACCESS_TOKEN, "ae-access-token"),
      refreshToken: cfg.AE_REFRESH_TOKEN
        ? encryptSecret(cfg.AE_REFRESH_TOKEN, "ae-refresh-token")
        : null,
      // البيئة لا تحمل تاريخ انتهاء، فنتركه فارغًا: لا تجديد استباقي حتى
      // يعرّفه أول تجديد فعلي، ويبقى التجديد التفاعلي عند خطأ التفويض.
      expiresAt: null,
      refreshExpiresAt: null,
      lastError: null,
    },
    update: {
      accessToken: encryptSecret(cfg.AE_ACCESS_TOKEN, "ae-access-token"),
      refreshToken: cfg.AE_REFRESH_TOKEN
        ? encryptSecret(cfg.AE_REFRESH_TOKEN, "ae-refresh-token")
        : null,
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
