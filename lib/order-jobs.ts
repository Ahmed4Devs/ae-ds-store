import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { sourceOrderFromAliExpress } from "@/lib/orders";
import { safeErrorKind } from "@/lib/safe-log";

const SOURCE_KIND = "SOURCE_ORDER" as const;
const SOURCE_DEDUPE_PREFIX = "source-order:v1:";
const LEASE_MS = 15 * 60_000;
const MAX_BATCH = 25;
const RETRY_DELAYS_MS = [
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

type QueueClient = Pick<typeof prisma, "orderJob">;

export interface SourceJobRun {
  claimed: number;
  completed: number;
  retried: number;
  dead: number;
}

function boundedLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, MAX_BATCH)
    : 10;
}

function retryAt(attempt: number): Date {
  const index = Math.min(
    Math.max(0, attempt - 1),
    RETRY_DELAYS_MS.length - 1,
  );
  return new Date(Date.now() + RETRY_DELAYS_MS[index]);
}

function safeJobCode(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value
          .toUpperCase()
          .replace(/[^A-Z0-9_:-]/gu, "_")
          .slice(0, 100)
      : "";
  return normalized || "UNEXPECTED_SOURCE_ERROR";
}

/**
 * تُستدعى داخل معاملة تسوية الدفع نفسها عند الإمكان. upsert الخامل يمنع
 * webhook مكررًا أو استدراك cron من إنشاء أكثر من مهمة شراء للطلبية.
 */
export async function enqueueSourceOrderJob(
  orderId: string,
  db: QueueClient = prisma,
): Promise<void> {
  await db.orderJob.upsert({
    where: {
      orderId_kind: {
        orderId,
        kind: SOURCE_KIND,
      },
    },
    create: {
      orderId,
      kind: SOURCE_KIND,
      dedupeKey: SOURCE_DEDUPE_PREFIX + orderId,
    },
    // لا نعيد فتح COMPLETED أو DEAD ضمن مسار آلي. إعادة DEAD قرار إداري
    // صريح يمر بسجل التدقيق.
    update: {},
  });
}

/** يعيد فتح مهمة فاشلة بعد تحقق المسؤول من سبب المراجعة. */
export async function requeueSourceOrderJob(orderId: string): Promise<void> {
  await prisma.orderJob.upsert({
    where: {
      orderId_kind: {
        orderId,
        kind: SOURCE_KIND,
      },
    },
    create: {
      orderId,
      kind: SOURCE_KIND,
      dedupeKey: SOURCE_DEDUPE_PREFIX + orderId,
    },
    update: {
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
      completedAt: null,
    },
  });
}

async function completeJob(jobId: string, leaseToken: string): Promise<boolean> {
  const completed = await prisma.orderJob.updateMany({
    where: { id: jobId, status: "PROCESSING", leaseToken },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
    },
  });
  return completed.count === 1;
}

async function retryJob(
  jobId: string,
  leaseToken: string,
  attempt: number,
  code: string,
): Promise<boolean> {
  const retried = await prisma.orderJob.updateMany({
    where: { id: jobId, status: "PROCESSING", leaseToken },
    data: {
      status: "PENDING",
      nextAttemptAt: retryAt(attempt),
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: safeJobCode(code),
      lastErrorAt: new Date(),
    },
  });
  return retried.count === 1;
}

async function deadLetterJob(
  jobId: string,
  orderId: string,
  leaseToken: string,
  code: string,
): Promise<boolean> {
  const safeCode = safeJobCode(code);
  return prisma.$transaction(async (tx) => {
    const dead = await tx.orderJob.updateMany({
      where: { id: jobId, status: "PROCESSING", leaseToken },
      data: {
        status: "DEAD",
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: safeCode,
        lastErrorAt: new Date(),
      },
    });
    if (dead.count !== 1) return false;

    await tx.order.updateMany({
      where: {
        id: orderId,
        aeOrders: { none: {} },
        status: { notIn: ["CANCELLED", "DELIVERED"] },
        needsManualReview: false,
      },
      data: {
        needsManualReview: true,
        manualReviewCode: "SOURCE_JOB_DEAD",
        manualReviewNote:
          "استنفدت مهمة التوريد محاولاتها أو توقفت بخطأ غير قابل للإعادة.",
        manualReviewOpenedAt: new Date(),
        manualReviewResolvedAt: null,
      },
    });
    return true;
  });
}

/**
 * عامل مهام صغير يصلح للمهمة المجدولة و after(). الحجز كتابة شرطية ومعه
 * lease token؛ لا تستطيع نسخة متأخرة إكمال مهمة استردتها نسخة أخرى.
 */
export async function processSourceOrderJobs(
  options: { limit?: number; orderId?: string } = {},
): Promise<SourceJobRun> {
  const limit = boundedLimit(options.limit);
  const now = new Date();
  const candidates = await prisma.orderJob.findMany({
    where: {
      kind: SOURCE_KIND,
      ...(options.orderId ? { orderId: options.orderId } : {}),
      OR: [
        { status: "PENDING", nextAttemptAt: { lte: now } },
        { status: "PROCESSING", leaseExpiresAt: { lt: now } },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: {
      id: true,
      orderId: true,
      attempts: true,
      maxAttempts: true,
    },
  });

  const result: SourceJobRun = {
    claimed: 0,
    completed: 0,
    retried: 0,
    dead: 0,
  };

  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    const claimNow = new Date();
    const claim = await prisma.orderJob.updateMany({
      where: {
        id: candidate.id,
        kind: SOURCE_KIND,
        OR: [
          {
            status: "PENDING",
            nextAttemptAt: { lte: claimNow },
          },
          {
            status: "PROCESSING",
            leaseExpiresAt: { lt: claimNow },
          },
        ],
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
    if (claim.count !== 1) continue;

    result.claimed++;
    const attempt = candidate.attempts + 1;
    if (attempt > candidate.maxAttempts) {
      if (
        await deadLetterJob(
          candidate.id,
          candidate.orderId,
          leaseToken,
          "SOURCE_JOB_ATTEMPTS_EXHAUSTED",
        )
      ) {
        result.dead++;
      }
      continue;
    }

    try {
      const outcome = await sourceOrderFromAliExpress(candidate.orderId);
      if (outcome.ok) {
        if (await completeJob(candidate.id, leaseToken)) {
          result.completed++;
          const { sendOrderPlacedMail } = await import("@/lib/mail");
          await sendOrderPlacedMail(candidate.orderId);
        }
        continue;
      }

      // SOURCING حديثة تعني أن تنفيذًا آخر سبقنا أو أن محاولة سابقة ماتت
      // قبل أقل من مهلة الاسترداد. كلاهما يعاد لاحقًا ولا يرسل إلى dead-letter.
      if (outcome.retryable || outcome.errorCode === "SOURCING_IN_PROGRESS") {
        if (attempt >= candidate.maxAttempts) {
          if (
            await deadLetterJob(
              candidate.id,
              candidate.orderId,
              leaseToken,
              outcome.errorCode,
            )
          ) {
            result.dead++;
          }
        } else if (
          await retryJob(
            candidate.id,
            leaseToken,
            attempt,
            outcome.errorCode,
          )
        ) {
          result.retried++;
        }
      } else if (
        await deadLetterJob(
          candidate.id,
          candidate.orderId,
          leaseToken,
          outcome.errorCode,
        )
      ) {
        result.dead++;
      }
    } catch (error) {
      const code = safeJobCode(safeErrorKind(error));
      console.error(
        "[order-jobs] فشلت مهمة توريد " + candidate.id + ":",
        code,
      );
      if (attempt >= candidate.maxAttempts) {
        if (
          await deadLetterJob(
            candidate.id,
            candidate.orderId,
            leaseToken,
            code,
          )
        ) {
          result.dead++;
        }
      } else if (
        await retryJob(candidate.id, leaseToken, attempt, code)
      ) {
        result.retried++;
      }
    }
  }

  return result;
}

/**
 * يضيف مهامًا لصفوف تاريخية أو لفشل وقع قبل إنشاء OrderJob. لا يعيد فتح
 * طلبية عليها مراجعة أو بلا إثبات مالي، ولا يلمس ما له أثر مورد.
 */
export async function backfillRecoverableSourceJobs(limit = 100): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60_000);
  const rows = await prisma.order.findMany({
    where: {
      status: { in: ["PAID", "SOURCING"] },
      needsManualReview: false,
      updatedAt: { lt: cutoff },
      payments: { some: { status: "PAID" } },
      aeOrders: { none: {} },
      jobs: { none: { kind: SOURCE_KIND } },
    },
    orderBy: { updatedAt: "asc" },
    take: boundedLimit(limit),
    select: { id: true },
  });

  for (const row of rows) {
    await enqueueSourceOrderJob(row.id);
  }
  return rows.length;
}
