import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { env } from "@/lib/env";

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

function createPool(): Pool {
  const pool = new Pool({
    connectionString: env().DATABASE_URL,
    max: 10,
    // أقصر من مهلة الخمول لدى الخادم حتى نتخلّص من الاتصال قبل أن يقطعه
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });

  // بدون هذا المعالج يتحوّل خطأ اتصال خامل إلى استثناء غير ملتقَط
  // يُسقط العملية بأكملها.
  pool.on("error", (err) => {
    console.error("[pg] خطأ في اتصال خامل — سيُستبدل:", err.message);
  });

  return pool;
}

function createClient(): PrismaClient {
  const pool = globalForPrisma.pgPool ?? createPool();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pgPool = pool;
  }

  return new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
