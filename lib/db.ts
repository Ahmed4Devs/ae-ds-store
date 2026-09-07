import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { env } from "@/lib/env";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * عميل Prisma وحيد النسخة.
 *
 * Prisma 7 يتطلّب مُهيّئ تعريف (driver adapter). نمرّر تجمّع اتصالات pg
 * صريحًا بدل نص الاتصال وحده، لأن التجمّع الافتراضي يُترك بلا معالج
 * أخطاء: فإذا أغلق الخادم اتصالًا خاملًا انفجر الطلب التالي بالخطأ
 * P1017 «Server has closed the connection» بدل أن يُستبدل الاتصال بهدوء.
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pgPool?: Pool;
};

/**
 * يستخرج اسم المخطّط من مُعامل `?schema=` في رابط الاتصال.
 *
 * ⚠️ هذا المُعامل اصطلاح خاص بـ Prisma، وبرنامج تشغيل `pg` يتجاهله تمامًا.
 * فأداة الترحيل تُنشئ الجداول في المخطّط المطلوب بينما يستعلم وقت التشغيل
 * في `public` — وهو تعارض صامت خطير حين تشترك قاعدة البيانات مع مشروع
 * آخر يحمل أسماء جداول مشابهة. لذا نقرأ القيمة هنا ونمرّرها للمُهيّئ صراحةً.
 */
function schemaFromUrl(url: string): string | undefined {
  try {
    const schema = new URL(url).searchParams.get("schema");
    return schema && schema.trim() !== "" ? schema : undefined;
  } catch {
    return undefined;
  }
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString: env().DATABASE_URL,
    // سقف صريح وقابل للضبط: كل نسخة serverless تملك تجمّعها الخاص، ولذلك
    // كان الرقم 10 يتضاعف سريعًا حتى يستنزف max_connections في PostgreSQL.
    max: env().DB_POOL_MAX,
    // أقصر من مهلة الخمول لدى الخادم حتى نتخلّص من الاتصال قبل أن يقطعه
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // يوقف الاستعلام المعلّق بدل إبقاء اتصال وطلب HTTP محجوزين بلا نهاية.
    statement_timeout: 15_000,
    query_timeout: 20_000,
    keepAlive: true,
    // أدوات التحقق عمليات CLI قصيرة. إبقاء مقبس خامل ممسوكًا كان يؤخر كل
    // أداة 30 ثانية بعد نجاحها؛ في غير الإنتاج اسمح لـ Node بالخروج عندما
    // لا يبقى عمل، من دون تغيير إعادة استخدام الاتصالات داخل خادم التطوير.
    allowExitOnIdle: process.env.NODE_ENV !== "production",
  });

  // بدون هذا المعالج يتحوّل خطأ اتصال خامل إلى استثناء غير ملتقَط
  // يُسقط العملية بأكملها.
  pool.on("error", (err) => {
    console.error(
      "[pg] خطأ في اتصال خامل — سيُستبدل:",
      safeErrorKind(err),
    );
  });

  return pool;
}

function createClient(): PrismaClient {
  const pool = globalForPrisma.pgPool ?? createPool();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pgPool = pool;
  }

  const schema = schemaFromUrl(env().DATABASE_URL);

  return new PrismaClient({
    adapter: new PrismaPg(pool, schema ? { schema } : undefined),
    // Prisma error events can contain SQL fragments and bound values. Keep
    // detailed output in local development only; production callers emit
    // explicit low-cardinality labels through safeErrorKind instead.
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : [],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
