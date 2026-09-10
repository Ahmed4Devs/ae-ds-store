import { prisma } from "@/lib/db";

const SOURCE_DEDUPE_PREFIX = "source-order:v1:";

export type ReviewActionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "INVALID"
        | "NOT_FOUND"
        | "NOT_RETRYABLE"
        | "CONFLICT"
        | "UNSAFE_TO_RESOLVE";
    };

function normalizeReason(value: string): string | null {
  const reason = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return reason.length >= 3 && reason.length <= 500 ? reason : null;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

const RETRYABLE_SOURCE_REVIEWS = new Set([
  "SOURCE_VARIANT_UNAVAILABLE",
  "SOURCE_SHIPPING_UNAVAILABLE",
  "SOURCE_OUT_OF_STOCK",
  "SOURCE_INSUFFICIENT_STOCK",
  "SOURCE_COST_INCREASE",
  "SOURCE_JOB_DEAD",
]);

/** موافقة صريحة ومدققة لإعادة محاولة توريد كان موقوفًا للمراجعة. */
export async function retryReviewedSourcing(input: {
  orderId: string;
  actorUserId: string;
  reason: string;
}): Promise<ReviewActionResult> {
  const reason = normalizeReason(input.reason);
  if (!validId(input.orderId) || !validId(input.actorUserId) || !reason) {
    return { ok: false, code: "INVALID" };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE
    `;
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: {
        status: true,
        updatedAt: true,
        needsManualReview: true,
        manualReviewCode: true,
        _count: { select: { aeOrders: true } },
      },
    });
    if (!order) return { ok: false as const, code: "NOT_FOUND" as const };

    const paidCount = await tx.paymentIntent.count({
      where: { orderId: input.orderId, status: "PAID" },
    });
    const staleSourcing =
      order.status === "SOURCING" &&
      order.updatedAt < new Date(Date.now() - 2 * 60_000);
    if (
      !order.needsManualReview ||
      !order.manualReviewCode ||
      !RETRYABLE_SOURCE_REVIEWS.has(order.manualReviewCode) ||
      order._count.aeOrders !== 0 ||
      paidCount !== 1 ||
      (!staleSourcing &&
        order.status !== "PAID" &&
        order.status !== "SOURCING_FAILED")
    ) {
      return { ok: false as const, code: "NOT_RETRYABLE" as const };
    }

    await tx.order.update({
      where: { id: input.orderId },
      data: {
        status: "PAID",
        needsManualReview: false,
        manualReviewCode: null,
        manualReviewNote: null,
        manualReviewResolvedAt: new Date(),
      },
    });
    await tx.orderJob.upsert({
      where: {
        orderId_kind: { orderId: input.orderId, kind: "SOURCE_ORDER" },
      },
      create: {
        orderId: input.orderId,
        kind: "SOURCE_ORDER",
        dedupeKey: SOURCE_DEDUPE_PREFIX + input.orderId,
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
    await tx.adminAuditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: "SOURCE_RETRY_APPROVED",
        targetType: "Order",
        targetId: input.orderId,
        reason,
        metadata: { previousReviewCode: order.manualReviewCode },
      },
    });
    return { ok: true as const };
  });
}

/** يربط أثر المورد بعد مطابقة بشرية بدل إعادة شراء طلبية قد تكون موجودة. */
export async function attachReviewedSupplierOrders(input: {
  orderId: string;
  actorUserId: string;
  reason: string;
  aeOrderIds: string[];
}): Promise<ReviewActionResult> {
  const reason = normalizeReason(input.reason);
  const ids = [...new Set(input.aeOrderIds.map((value) => value.trim()))];
  if (
    !validId(input.orderId) ||
    !validId(input.actorUserId) ||
    !reason ||
    ids.length === 0 ||
    ids.length > 10 ||
    ids.some((value) => !/^\d{5,32}$/u.test(value))
  ) {
    return { ok: false, code: "INVALID" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE
      `;
      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        select: {
          status: true,
          placedAt: true,
          needsManualReview: true,
          manualReviewCode: true,
          _count: { select: { aeOrders: true } },
        },
      });
      if (!order) return { ok: false as const, code: "NOT_FOUND" as const };
      const paidCount = await tx.paymentIntent.count({
        where: { orderId: input.orderId, status: "PAID" },
      });
      if (
        !order.needsManualReview ||
        order._count.aeOrders !== 0 ||
        paidCount !== 1 ||
        !["PAID", "SOURCING", "SOURCING_FAILED"].includes(order.status)
      ) {
        return { ok: false as const, code: "NOT_RETRYABLE" as const };
      }

      await tx.aeOrder.createMany({
        data: ids.map((aeOrderId) => ({ orderId: input.orderId, aeOrderId })),
      });
      await tx.order.update({
        where: { id: input.orderId },
        data: {
          status: "SOURCED",
          placedAt: order.placedAt ?? new Date(),
          needsManualReview: false,
          manualReviewCode: null,
          manualReviewNote: null,
          manualReviewResolvedAt: new Date(),
        },
      });
      await tx.orderJob.upsert({
        where: {
          orderId_kind: { orderId: input.orderId, kind: "SOURCE_ORDER" },
        },
        create: {
          orderId: input.orderId,
          kind: "SOURCE_ORDER",
          status: "COMPLETED",
          dedupeKey: SOURCE_DEDUPE_PREFIX + input.orderId,
          completedAt: new Date(),
        },
        update: {
          status: "COMPLETED",
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "SUPPLIER_ORDERS_ATTACHED",
          targetType: "Order",
          targetId: input.orderId,
          reason,
          metadata: {
            aeOrderIds: ids,
            previousReviewCode: order.manualReviewCode,
          },
        },
      });
      return { ok: true as const };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

/** يربط مرجعًا تحقّق منه المسؤول ثم يعيد المصالحة فقط، بلا POST جديد. */
export async function reconcileReviewedRefund(input: {
  orderId: string;
  actorUserId: string;
  reason: string;
  providerRefundRef: string;
}): Promise<ReviewActionResult & { refundId?: string }> {
  const reason = normalizeReason(input.reason);
  const refundRef = input.providerRefundRef.trim();
  if (
    !validId(input.orderId) ||
    !validId(input.actorUserId) ||
    !reason ||
    !/^[A-Za-z0-9_-]{5,160}$/u.test(refundRef)
  ) {
    return { ok: false, code: "INVALID" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE
      `;
      const refund = await tx.refundRequest.findFirst({
        where: { orderId: input.orderId },
        orderBy: { createdAt: "desc" },
        select: { id: true, provider: true, status: true },
      });
      if (!refund) return { ok: false as const, code: "NOT_FOUND" as const };
      const formatOk =
        refund.provider === "moyasar"
          ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              refundRef,
            )
          : refund.provider === "tap"
            ? /^re_[A-Za-z0-9_-]{3,140}$/u.test(refundRef)
            : false;
      if (refund.status !== "REQUIRES_REVIEW" || !formatOk) {
        return { ok: false as const, code: "NOT_RETRYABLE" as const };
      }

      await tx.refundRequest.update({
        where: { id: refund.id },
        data: {
          status: "PENDING",
          providerRefundRef: refundRef,
          attempts: 0,
          nextAttemptAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorNote: null,
        },
      });
      await tx.order.update({
        where: { id: input.orderId },
        data: {
          needsManualReview: true,
          manualReviewCode: "REFUND_IN_PROGRESS",
          manualReviewNote:
            "أُرفق مرجع استرداد موثّق وتنتظر الطلبية مصالحة المزوّد.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "REFUND_RECONCILIATION_APPROVED",
          targetType: "RefundRequest",
          targetId: refund.id,
          reason,
          metadata: { orderId: input.orderId, provider: refund.provider },
        },
      });
      return { ok: true as const, refundId: refund.id };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

/** إغلاق مدقّق لمراجعة لا تملك عملًا ماليًا أو توريدًا آليًا معلّقًا. */
export async function resolveManualReview(input: {
  orderId: string;
  actorUserId: string;
  reason: string;
}): Promise<ReviewActionResult> {
  const reason = normalizeReason(input.reason);
  if (!validId(input.orderId) || !validId(input.actorUserId) || !reason) {
    return { ok: false, code: "INVALID" };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE
    `;
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: {
        status: true,
        refundedAt: true,
        needsManualReview: true,
        manualReviewCode: true,
        _count: { select: { aeOrders: true } },
      },
    });
    if (!order) return { ok: false as const, code: "NOT_FOUND" as const };
    const [paidCount, activeRefunds] = await Promise.all([
      tx.paymentIntent.count({
        where: { orderId: input.orderId, status: "PAID" },
      }),
      tx.refundRequest.count({
        where: {
          orderId: input.orderId,
          status: { in: ["PENDING", "PROCESSING", "REQUIRES_REVIEW"] },
        },
      }),
    ]);
    const sourcingNeedsDedicatedAction =
      ["PAID", "SOURCING", "SOURCING_FAILED"].includes(order.status) &&
      order._count.aeOrders === 0;
    const cancelledWithUnrefundedPayment =
      order.status === "CANCELLED" && paidCount > 0 && !order.refundedAt;
    if (
      !order.needsManualReview ||
      activeRefunds > 0 ||
      paidCount > 1 ||
      sourcingNeedsDedicatedAction ||
      cancelledWithUnrefundedPayment
    ) {
      return {
        ok: false as const,
        code: "UNSAFE_TO_RESOLVE" as const,
      };
    }

    await tx.order.update({
      where: { id: input.orderId },
      data: {
        needsManualReview: false,
        manualReviewCode: null,
        manualReviewNote: null,
        manualReviewResolvedAt: new Date(),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: "MANUAL_REVIEW_RESOLVED",
        targetType: "Order",
        targetId: input.orderId,
        reason,
        metadata: { previousReviewCode: order.manualReviewCode },
      },
    });
    return { ok: true as const };
  });
}
