import { prisma } from "@/lib/db";

export interface DatabaseRateLimitDecision {
  ok: boolean;
  retryAfter: number;
}

/**
 * محدّد نافذة موزّع فوق جدول Better Auth نفسه.
 *
 * القفل الاستشاري مرتبط بالمفتاح وداخل المعاملة، فيجعل القراءة/الزيادة
 * عملية واحدة ذرية عبر كل نسخ الخادم. الاستعلام tagged؛ المفتاح parameter
 * لا جزء من SQL، وتحويل void إلى text مطلوب مع Prisma driver adapter.
 */
export async function consumeDatabaseRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<DatabaseRateLimitDecision> {
  if (
    key.length === 0 ||
    key.length > 255 ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000
  ) {
    throw new TypeError("Invalid database rate-limit parameters");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "locked"
    `;

    const now = Date.now();
    const cutoff = BigInt(now - windowMs);
    const current = await tx.rateLimit.findUnique({
      where: { key },
      select: { id: true, count: true, lastRequest: true },
    });

    if (!current || current.lastRequest <= cutoff) {
      await tx.rateLimit.upsert({
        where: { key },
        create: { key, count: 1, lastRequest: BigInt(now) },
        update: { count: 1, lastRequest: BigInt(now) },
      });
      return { ok: true, retryAfter: 0 };
    }

    if (current.count >= max) {
      const remainingMs = current.lastRequest + BigInt(windowMs) - BigInt(now);
      return {
        ok: false,
        retryAfter: Math.max(
          1,
          Number((remainingMs + BigInt(999)) / BigInt(1_000)),
        ),
      };
    }

    await tx.rateLimit.update({
      where: { id: current.id },
      data: { count: { increment: 1 }, lastRequest: BigInt(now) },
    });
    return { ok: true, retryAfter: 0 };
  });
}
