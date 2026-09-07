import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_BATCH = 5_000;

export interface SecurityRetentionResult {
  expiredSessions: number;
  expiredVerifications: number;
  staleRateLimits: number;
  expiredGuestCapabilities: number;
  oldApiLogs: number;
}

/**
 * كنس دوري للبيانات الحسّاسة أو التشغيلية التي انتهى غرضها.
 *
 * حذف سجل المنصة يجري على دفعة محدودة حتى لا تتحول أول دورة بعد انقطاع
 * المجدول إلى DELETE ضخم يحجز الجدول. الدورات التالية تكمل الباقي.
 */
export async function purgeExpiredSecurityState(): Promise<SecurityRetentionResult> {
  const now = new Date();
  const staleRateLimitBefore = BigInt(Date.now() - DAY_MS);
  const logBefore = new Date(
    Date.now() - env().AE_API_LOG_RETENTION_DAYS * DAY_MS,
  );

  const [sessionIds, verificationIds, rateLimitIds, capabilityIds, oldLogIds] =
    await Promise.all([
      prisma.session.findMany({
        where: { expiresAt: { lte: now } },
        orderBy: { expiresAt: "asc" },
        take: DELETE_BATCH,
        select: { id: true },
      }),
      prisma.verification.findMany({
        where: { expiresAt: { lte: now } },
        orderBy: { expiresAt: "asc" },
        take: DELETE_BATCH,
        select: { id: true },
      }),
      prisma.rateLimit.findMany({
        where: { lastRequest: { lt: staleRateLimitBefore } },
        orderBy: { lastRequest: "asc" },
        take: DELETE_BATCH,
        select: { id: true },
      }),
      prisma.order.findMany({
        where: {
          guestAccessExpiresAt: { lte: now },
          guestAccessHash: { not: null },
        },
        orderBy: { guestAccessExpiresAt: "asc" },
        take: DELETE_BATCH,
        select: { id: true },
      }),
      prisma.aeApiLog.findMany({
        where: { createdAt: { lt: logBefore } },
        orderBy: { createdAt: "asc" },
        take: DELETE_BATCH,
        select: { id: true },
      }),
    ]);

  const [sessions, verifications, rateLimits, capabilities, logs] =
    await prisma.$transaction([
      prisma.session.deleteMany({
        where: {
          id: { in: sessionIds.map((row) => row.id) },
          expiresAt: { lte: now },
        },
      }),
      prisma.verification.deleteMany({
        where: {
          id: { in: verificationIds.map((row) => row.id) },
          expiresAt: { lte: now },
        },
      }),
      prisma.rateLimit.deleteMany({
        where: {
          id: { in: rateLimitIds.map((row) => row.id) },
          lastRequest: { lt: staleRateLimitBefore },
        },
      }),
      prisma.order.updateMany({
        where: {
          id: { in: capabilityIds.map((row) => row.id) },
          guestAccessExpiresAt: { lte: now },
          guestAccessHash: { not: null },
        },
        data: { guestAccessHash: null, guestAccessExpiresAt: null },
      }),
      prisma.aeApiLog.deleteMany({
        where: { id: { in: oldLogIds.map((row) => row.id) } },
      }),
    ]);

  return {
    expiredSessions: sessions.count,
    expiredVerifications: verifications.count,
    staleRateLimits: rateLimits.count,
    expiredGuestCapabilities: capabilities.count,
    oldApiLogs: logs.count,
  };
}
