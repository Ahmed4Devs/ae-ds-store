import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { moyasarProvider } from "@/lib/payments/moyasar";
import { tapProvider } from "@/lib/payments/tap";
import {
  PaymentError,
  type FullRefundInput,
  type PaymentProvider,
  type ProviderRefund,
} from "@/lib/payments/types";

const LEASE_MS = 10 * 60_000;
const MAX_BATCH = 20;
const TAP_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60_000;
const RETRY_DELAYS_MS = [
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
] as const;

const REFUNDABLE_PROVIDERS = {
  moyasar: moyasarProvider,
  tap: tapProvider,
} as const;

export type RefundFailureCode =
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_REFUNDABLE"
  | "PAYMENT_NOT_REFUNDABLE"
  | "MANUAL_REVIEW_REQUIRED"
  | "MANUAL_PROVIDER_UNSUPPORTED";

export type RequestRefundResult =
  | {
      ok: true;
      refundId: string;
      status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "REQUIRES_REVIEW";
      created: boolean;
    }
  | { ok: false; code: RefundFailureCode };

export interface RefundRun {
  claimed: number;
  completed: number;
  pending: number;
  review: number;
}

export interface RequestFullRefundInput {
  orderId: string;
  actorUserId: string;
  reason: string;
  providerReason: FullRefundInput["reason"];
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function normalizeReason(value: string): string | null {
  const reason = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return reason.length >= 3 && reason.length <= 500 ? reason : null;
}

function providerReasonValid(
  value: string,
): value is FullRefundInput["reason"] {
  return (
    value === "duplicate" ||
    value === "fraudulent" ||
    value === "requested_by_customer"
  );
}

function refundProvider(
  name: string,
): (PaymentProvider & Required<Pick<PaymentProvider, "refund" | "retrieveRefund">>) | null {
  const candidate =
    name === "moyasar"
      ? REFUNDABLE_PROVIDERS.moyasar
      : name === "tap"
        ? REFUNDABLE_PROVIDERS.tap
        : null;
  if (!candidate?.refund || !candidate.retrieveRefund) return null;
  return candidate as PaymentProvider &
    Required<Pick<PaymentProvider, "refund" | "retrieveRefund">>;
}

/**
 * يثبت طلب full refund فقط، تحت قفل الطلبية والدفعة. لا يجري أي اتصال
 * شبكي داخل المعاملة، ولا يسمح بطلب ثانٍ لدفعة واحدة.
 */
export async function requestFullRefund(
  input: RequestFullRefundInput,
): Promise<RequestRefundResult> {
  const reason = normalizeReason(input.reason);
  if (
    !validId(input.orderId) ||
    !validId(input.actorUserId) ||
    !reason ||
    !providerReasonValid(input.providerReason)
  ) {
    return { ok: false, code: "ORDER_NOT_REFUNDABLE" };
  }

  const located = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true },
  });
  if (!located) return { ok: false, code: "ORDER_NOT_FOUND" };

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order" WHERE "id" = ${located.id} FOR UPDATE
    `;

    const existing = await tx.refundRequest.findFirst({
      where: { orderId: located.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (existing) {
      return {
        ok: true as const,
        refundId: existing.id,
        status: existing.status,
        created: false,
      };
    }

    const order = await tx.order.findUnique({
      where: { id: located.id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalSar: true,
        refundedAt: true,
        needsManualReview: true,
      },
    });
    if (!order) return { ok: false as const, code: "ORDER_NOT_FOUND" as const };
    if (order.needsManualReview) {
      return {
        ok: false as const,
        code: "MANUAL_REVIEW_REQUIRED" as const,
      };
    }
    if (
      order.refundedAt ||
      !["PAID", "SOURCING_FAILED", "SOURCED", "SHIPPED", "DELIVERED"].includes(
        order.status,
      )
    ) {
      return {
        ok: false as const,
        code: "ORDER_NOT_REFUNDABLE" as const,
      };
    }

    const paid = await tx.paymentIntent.findMany({
      where: { orderId: order.id, status: "PAID" },
      orderBy: { paidAt: "desc" },
      take: 2,
      select: {
        id: true,
        provider: true,
        providerRef: true,
        amountSar: true,
        currency: true,
      },
    });
    if (paid.length !== 1) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          needsManualReview: true,
          manualReviewCode: "REFUND_PAYMENT_AMBIGUOUS",
          manualReviewNote:
            "لا توجد دفعة ناجحة وحيدة يمكن ربط الاسترداد الكامل بها.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "REFUND_REQUEST_REJECTED",
          targetType: "Order",
          targetId: order.id,
          reason,
          metadata: { code: "REFUND_PAYMENT_AMBIGUOUS" },
        },
      });
      return {
        ok: false as const,
        code: "PAYMENT_NOT_REFUNDABLE" as const,
      };
    }

    const payment = paid[0];
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PaymentIntent" WHERE "id" = ${payment.id} FOR UPDATE
    `;
    const amount = Number(payment.amountSar);
    if (payment.provider === "manual") {
      return {
        ok: false as const,
        code: "MANUAL_PROVIDER_UNSUPPORTED" as const,
      };
    }
    if (!refundProvider(payment.provider)) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          needsManualReview: true,
          manualReviewCode: "REFUND_PROVIDER_UNKNOWN",
          manualReviewNote:
            "مزوّد الدفعة المخزّن غير معروف لمسار الاسترداد الآلي.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
      return {
        ok: false as const,
        code: "PAYMENT_NOT_REFUNDABLE" as const,
      };
    }
    if (
      payment.currency !== "SAR" ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount !== Number(order.totalSar)
    ) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          needsManualReview: true,
          manualReviewCode: "REFUND_FINANCIAL_MISMATCH",
          manualReviewNote:
            "مبلغ أو عملة الدفعة لا يطابقان إجمالي الطلبية عند طلب الاسترداد.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
      return {
        ok: false as const,
        code: "PAYMENT_NOT_REFUNDABLE" as const,
      };
    }

    const created = await tx.refundRequest.create({
      data: {
        orderId: order.id,
        paymentIntentId: payment.id,
        idempotencyKey: `refund_full_v1:${payment.id}`,
        provider: payment.provider,
        amountSar: payment.amountSar,
        currency: payment.currency,
        reason,
        providerReason: input.providerReason,
        requestedByUserId: input.actorUserId,
      },
      select: { id: true, status: true },
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        needsManualReview: true,
        manualReviewCode: "REFUND_IN_PROGRESS",
        manualReviewNote:
          "طلب استرداد كامل قيد التنفيذ؛ أُوقف أي توريد آلي جديد.",
        manualReviewOpenedAt: new Date(),
        manualReviewResolvedAt: null,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: "REFUND_REQUESTED",
        targetType: "RefundRequest",
        targetId: created.id,
        reason,
        metadata: {
          orderId: order.id,
          paymentIntentId: payment.id,
          provider: payment.provider,
          amountSar: amount,
          currency: payment.currency,
          providerReason: input.providerReason,
        },
      },
    });

    return {
      ok: true as const,
      refundId: created.id,
      status: created.status,
      created: true,
    };
  });
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

function safeCode(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value
          .toUpperCase()
          .replace(/[^A-Z0-9_:-]/gu, "_")
          .slice(0, 100)
      : "";
  return normalized || "REFUND_PROVIDER_FAILURE";
}

function safeNote(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value
          .normalize("NFKC")
          .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 500)
      : "";
  return normalized || "تعذّر حسم نتيجة الاسترداد من مزوّد الدفع.";
}

function resultMatches(
  result: ProviderRefund,
  row: {
    provider: string;
    paymentIntent: { providerRef: string };
    orderId: string;
    amountSar: { toString(): string };
    currency: string;
    idempotencyKey: string;
  },
): boolean {
  return (
    result.provider === row.provider &&
    result.providerRef === row.paymentIntent.providerRef &&
    result.amountSar === Number(row.amountSar) &&
    result.currency === row.currency &&
    result.idempotencyKey === row.idempotencyKey &&
    /^[^\u0000-\u001f\u007f-\u009f]{1,160}$/u.test(result.refundRef)
  );
}

async function requeueRefund(
  id: string,
  leaseToken: string,
  attempt: number,
  providerRefundRef: string | null,
  code: string,
): Promise<boolean> {
  const updated = await prisma.refundRequest.updateMany({
    where: { id, status: "PROCESSING", leaseToken },
    data: {
      status: "PENDING",
      nextAttemptAt: retryAt(attempt),
      leaseToken: null,
      leaseExpiresAt: null,
      ...(providerRefundRef ? { providerRefundRef } : {}),
      lastErrorCode: safeCode(code),
      lastErrorNote: null,
    },
  });
  return updated.count === 1;
}

async function requireRefundReview(
  row: {
    id: string;
    orderId: string;
    requestedByUserId: string;
  },
  leaseToken: string,
  code: string,
  note: string,
  providerRefundRef?: string,
): Promise<boolean> {
  const errorCode = safeCode(code);
  const errorNote = safeNote(note);
  return prisma.$transaction(async (tx) => {
    const changed = await tx.refundRequest.updateMany({
      where: { id: row.id, status: "PROCESSING", leaseToken },
      data: {
        status: "REQUIRES_REVIEW",
        leaseToken: null,
        leaseExpiresAt: null,
        ...(providerRefundRef ? { providerRefundRef } : {}),
        lastErrorCode: errorCode,
        lastErrorNote: errorNote,
      },
    });
    if (changed.count !== 1) return false;

    await tx.order.update({
      where: { id: row.orderId },
      data: {
        needsManualReview: true,
        manualReviewCode: "REFUND_REQUIRES_REVIEW",
        manualReviewNote: errorNote,
        manualReviewOpenedAt: new Date(),
        manualReviewResolvedAt: null,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorUserId: row.requestedByUserId,
        action: "REFUND_REQUIRES_REVIEW",
        targetType: "RefundRequest",
        targetId: row.id,
        metadata: { orderId: row.orderId, code: errorCode },
      },
    });
    return true;
  });
}

async function completeRefund(
  row: {
    id: string;
    orderId: string;
    paymentIntentId: string;
    requestedByUserId: string;
    provider: string;
    amountSar: { toString(): string };
    currency: string;
  },
  leaseToken: string,
  result: ProviderRefund,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // نفس ترتيب بقية المسارات المالية: Order ثم PaymentIntent ثم Refund.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order" WHERE "id" = ${row.orderId} FOR UPDATE
    `;
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PaymentIntent" WHERE "id" = ${row.paymentIntentId} FOR UPDATE
    `;
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "RefundRequest" WHERE "id" = ${row.id} FOR UPDATE
    `;

    const [refund, payment, order, supplierOrders] = await Promise.all([
      tx.refundRequest.findUnique({
        where: { id: row.id },
        select: { status: true, leaseToken: true },
      }),
      tx.paymentIntent.findUnique({
        where: { id: row.paymentIntentId },
        select: { status: true },
      }),
      tx.order.findUnique({
        where: { id: row.orderId },
        select: { manualReviewCode: true, cancelledAt: true },
      }),
      tx.aeOrder.count({ where: { orderId: row.orderId } }),
    ]);
    if (
      !refund ||
      !payment ||
      !order ||
      refund.status !== "PROCESSING" ||
      refund.leaseToken !== leaseToken ||
      (payment.status !== "PAID" && payment.status !== "REFUNDED")
    ) {
      return false;
    }

    if (payment.status === "PAID") {
      await tx.paymentIntent.update({
        where: { id: row.paymentIntentId },
        data: {
          status: "REFUNDED",
          failureCode: null,
          failureMessage: null,
        },
      });
    }
    await tx.refundRequest.update({
      where: { id: row.id },
      data: {
        status: "SUCCEEDED",
        providerRefundRef: result.refundRef,
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorNote: null,
      },
    });

    const now = new Date();
    if (supplierOrders === 0) {
      await tx.order.update({
        where: { id: row.orderId },
        data: {
          status: "CANCELLED",
          refundedAt: now,
          cancelledAt: order.cancelledAt ?? now,
          cancelReason: "اكتمل استرداد المبلغ بالكامل إلى العميل.",
          needsManualReview: false,
          manualReviewCode: null,
          manualReviewNote: null,
          manualReviewResolvedAt: now,
        },
      });
    } else {
      await tx.order.update({
        where: { id: row.orderId },
        data: {
          refundedAt: now,
          needsManualReview: true,
          manualReviewCode: "REFUNDED_AFTER_SOURCING",
          manualReviewNote:
            "اكتمل استرداد العميل وللطلبية أثر لدى المورد؛ راجع الإلغاء أو الخسارة.",
          manualReviewOpenedAt: now,
          manualReviewResolvedAt: null,
        },
      });
    }
    await tx.adminAuditLog.create({
      data: {
        actorUserId: row.requestedByUserId,
        action: "REFUND_SUCCEEDED",
        targetType: "RefundRequest",
        targetId: row.id,
        metadata: {
          orderId: row.orderId,
          paymentIntentId: row.paymentIntentId,
          provider: row.provider,
          providerRefundRef: result.refundRef,
          amountSar: Number(row.amountSar),
          currency: row.currency,
          supplierOrders,
        },
      },
    });
    return true;
  });
}

/** عامل الاسترداد الدائم؛ إنشاء الطلب والمصالحة منفصلان عن طلب HTTP. */
export async function processRefundRequests(
  options: { limit?: number; refundId?: string } = {},
): Promise<RefundRun> {
  const now = new Date();
  const candidates = await prisma.refundRequest.findMany({
    where: {
      ...(options.refundId ? { id: options.refundId } : {}),
      OR: [
        { status: "PENDING", nextAttemptAt: { lte: now } },
        { status: "PROCESSING", leaseExpiresAt: { lt: now } },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: boundedLimit(options.limit),
    select: {
      id: true,
      orderId: true,
      paymentIntentId: true,
      attempts: true,
      maxAttempts: true,
      createdAt: true,
    },
  });
  const stats: RefundRun = { claimed: 0, completed: 0, pending: 0, review: 0 };

  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    const claimAt = new Date();
    const claimed = await prisma.refundRequest.updateMany({
      where: {
        id: candidate.id,
        OR: [
          { status: "PENDING", nextAttemptAt: { lte: claimAt } },
          { status: "PROCESSING", leaseExpiresAt: { lt: claimAt } },
        ],
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        submittedAt: new Date(),
      },
    });
    if (claimed.count !== 1) continue;
    stats.claimed++;

    const row = await prisma.refundRequest.findUnique({
      where: { id: candidate.id },
      include: {
        paymentIntent: {
          select: {
            providerRef: true,
            provider: true,
            status: true,
            amountSar: true,
            currency: true,
          },
        },
        order: { select: { orderNumber: true } },
      },
    });
    if (!row || row.leaseToken !== leaseToken || row.status !== "PROCESSING") {
      continue;
    }

    const provider = refundProvider(row.provider);
    if (!provider || row.paymentIntent.provider !== row.provider) {
      if (
        await requireRefundReview(
          row,
          leaseToken,
          "REFUND_PROVIDER_UNAVAILABLE",
          "مزوّد الدفعة لا يدعم الاسترداد الآلي أو لا يطابق سجل الطلب.",
        )
      ) {
        stats.review++;
      }
      continue;
    }

    if (
      (row.paymentIntent.status !== "PAID" &&
        row.paymentIntent.status !== "REFUNDED") ||
      row.paymentIntent.currency !== row.currency ||
      Number(row.paymentIntent.amountSar) !== Number(row.amountSar) ||
      !providerReasonValid(row.providerReason)
    ) {
      if (
        await requireRefundReview(
          row,
          leaseToken,
          "REFUND_LOCAL_INVARIANT",
          "تغيّر سجل الدفعة أو الاسترداد محليًا ولم يعد يطابق الطلب المثبّت.",
          row.providerRefundRef ?? undefined,
        )
      ) {
        stats.review++;
      }
      continue;
    }

    const attempt = candidate.attempts + 1;
    const fullInput: FullRefundInput = {
      kind: "full",
      providerRef: row.paymentIntent.providerRef,
      orderId: row.orderId,
      orderNumber: row.order.orderNumber,
      amountSar: Number(row.amountSar),
      currency: row.currency,
      idempotencyKey: row.idempotencyKey,
      reason: row.providerReason,
    };

    try {
      const result = row.providerRefundRef
        ? await provider.retrieveRefund({
            ...fullInput,
            refundRef: row.providerRefundRef,
          })
        : await provider.refund(fullInput);

      if (!resultMatches(result, row)) {
        throw new PaymentError(
          "PROVIDER_FAILED",
          "نتيجة الاسترداد لا تطابق السجل المحلي",
          { ambiguous: true },
        );
      }

      if (result.status === "REFUNDED") {
        if (await completeRefund(row, leaseToken, result)) {
          stats.completed++;
          const { sendOrderRefundedMail } = await import("@/lib/mail");
          await sendOrderRefundedMail(row.orderId);
        }
      } else if (result.status === "PENDING" && attempt < row.maxAttempts) {
        if (
          await requeueRefund(
            row.id,
            leaseToken,
            attempt,
            result.refundRef,
            "REFUND_PENDING",
          )
        ) {
          stats.pending++;
        }
      } else {
        const code =
          result.status === "FAILED"
            ? (result.failureCode ?? "REFUND_PROVIDER_REJECTED")
            : "REFUND_RECONCILIATION_EXHAUSTED";
        if (
          await requireRefundReview(
            row,
            leaseToken,
            code,
            result.failureMessage ??
              "لم يؤكد مزوّد الدفع اكتمال الاسترداد الكامل.",
            result.refundRef,
          )
        ) {
          stats.review++;
        }
      }
    } catch (error) {
      const ambiguous = error instanceof PaymentError && error.ambiguous;
      const withinTapWindow =
        row.provider === "tap" &&
        Date.now() - candidate.createdAt.getTime() < TAP_IDEMPOTENCY_WINDOW_MS;
      const safeToRetry =
        ambiguous &&
        attempt < row.maxAttempts &&
        (Boolean(row.providerRefundRef) || withinTapWindow);

      if (
        safeToRetry &&
        (await requeueRefund(
          row.id,
          leaseToken,
          attempt,
          row.providerRefundRef,
          "REFUND_RESULT_AMBIGUOUS",
        ))
      ) {
        stats.pending++;
      } else if (
        await requireRefundReview(
          row,
          leaseToken,
          ambiguous ? "REFUND_RESULT_AMBIGUOUS" : "REFUND_PROVIDER_FAILURE",
          ambiguous
            ? "أرسل طلب الاسترداد لكن تعذّر حسم نتيجته؛ يلزم تحقق يدوي قبل أي إعادة."
            : "رفض مزوّد الدفع الاسترداد أو أعاد استجابة غير موثوقة.",
          row.providerRefundRef ?? undefined,
        )
      ) {
        stats.review++;
      }
    }
  }

  return stats;
}
