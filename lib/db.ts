import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * عميل Prisma وحيد النسخة.
 * Prisma 7 يتطلّب مُهيّئ تعريف (driver adapter) — هنا PostgreSQL عبر pg.
 * في التطوير نحتفظ بالنسخة على globalThis حتى لا يفتح إعادة التحميل السريع
 * اتصالات جديدة في كل مرة.
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env().DATABASE_URL });
  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
