"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  attachReviewedSupplierOrders,
  reconcileReviewedRefund,
  resolveManualReview,
  retryReviewedSourcing,
} from "@/lib/manual-review";
import { processSourceOrderJobs } from "@/lib/order-jobs";
import { processRefundRequests, requestFullRefund } from "@/lib/refunds";
import { getDictionary } from "@/lib/i18n";
import { getCurrentUser, isAdmin } from "@/lib/session";
import { safeErrorKind } from "@/lib/safe-log";

const id = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const reason = z.string().trim().min(3).max(500);
const baseSchema = z.object({ orderId: id, reason }).strict();
const refundSchema = baseSchema
  .extend({
    providerReason: z.enum([
      "duplicate",
      "fraudulent",
      "requested_by_customer",
    ]),
  })
  .strict();
const attachSchema = baseSchema
  .extend({ aeOrderIds: z.string().trim().min(5).max(400) })
  .strict();
const reconcileSchema = baseSchema
  .extend({
    providerRefundRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{5,160}$/u),
  })
  .strict();

export type AdminReviewActionResult = { ok: boolean; message: string };

async function authorizedActor(): Promise<string | null> {
  if (!(await isAdmin())) return null;
  return (await getCurrentUser())?.id ?? null;
}

function refreshAdmin(): void {
  revalidatePath("/admin");
  revalidatePath("/admin/orders");
}

export async function requestFullRefundAction(
  input: z.input<typeof refundSchema>,
): Promise<AdminReviewActionResult> {
  const t = await getDictionary();
  const actorUserId = await authorizedActor();
  if (!actorUserId) return { ok: false, message: t.admin.unauthorized };
  const parsed = refundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.admin.invalidData };

  try {
    const result = await requestFullRefund({
      ...parsed.data,
      actorUserId,
    });
    if (!result.ok) {
      const message =
        result.code === "MANUAL_PROVIDER_UNSUPPORTED"
          ? t.admin.refundManualUnsupported
          : result.code === "MANUAL_REVIEW_REQUIRED"
            ? t.admin.refundResolveReviewFirst
            : t.admin.refundNotAllowed;
      return { ok: false, message };
    }

    if (result.status === "PENDING") {
      after(async () => {
        try {
          await processRefundRequests({ refundId: result.refundId, limit: 1 });
        } catch (error) {
          console.error(
            "[refund] تعذّر تشغيل محاولة الاسترداد الخلفية:",
            safeErrorKind(error),
          );
        }
      });
    }
    refreshAdmin();
    return {
      ok: true,
      message: result.created
        ? t.admin.refundQueued
        : t.admin.refundAlreadyRequested,
    };
  } catch (error) {
    console.error("[refund] تعذّر تثبيت طلب الاسترداد:", safeErrorKind(error));
    return { ok: false, message: t.admin.refundFailed };
  }
}

export async function retryReviewedSourcingAction(
  input: z.input<typeof baseSchema>,
): Promise<AdminReviewActionResult> {
  const t = await getDictionary();
  const actorUserId = await authorizedActor();
  if (!actorUserId) return { ok: false, message: t.admin.unauthorized };
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.admin.invalidData };

  const result = await retryReviewedSourcing({ ...parsed.data, actorUserId });
  if (!result.ok) return { ok: false, message: t.admin.reviewActionUnsafe };
  after(async () => {
    try {
      await processSourceOrderJobs({ orderId: parsed.data.orderId, limit: 1 });
    } catch (error) {
      console.error(
        "[orders] تعذّر تشغيل محاولة التوريد المعتمدة:",
        safeErrorKind(error),
      );
    }
  });
  refreshAdmin();
  return { ok: true, message: t.admin.reviewRetryQueued };
}

export async function attachReviewedSupplierOrdersAction(
  input: z.input<typeof attachSchema>,
): Promise<AdminReviewActionResult> {
  const t = await getDictionary();
  const actorUserId = await authorizedActor();
  if (!actorUserId) return { ok: false, message: t.admin.unauthorized };
  const parsed = attachSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.admin.invalidData };
  const aeOrderIds = parsed.data.aeOrderIds.split(/[\s,]+/u).filter(Boolean);
  const result = await attachReviewedSupplierOrders({
    orderId: parsed.data.orderId,
    actorUserId,
    reason: parsed.data.reason,
    aeOrderIds,
  });
  if (!result.ok) return { ok: false, message: t.admin.reviewActionUnsafe };
  refreshAdmin();
  return { ok: true, message: t.admin.reviewSupplierAttached };
}

export async function reconcileReviewedRefundAction(
  input: z.input<typeof reconcileSchema>,
): Promise<AdminReviewActionResult> {
  const t = await getDictionary();
  const actorUserId = await authorizedActor();
  if (!actorUserId) return { ok: false, message: t.admin.unauthorized };
  const parsed = reconcileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.admin.invalidData };
  const result = await reconcileReviewedRefund({ ...parsed.data, actorUserId });
  if (!result.ok || !result.refundId) {
    return { ok: false, message: t.admin.reviewActionUnsafe };
  }
  const refundId = result.refundId;
  after(async () => {
    try {
      await processRefundRequests({ refundId, limit: 1 });
    } catch (error) {
      console.error(
        "[refund] تعذّرت مصالحة الاسترداد المعتمدة:",
        safeErrorKind(error),
      );
    }
  });
  refreshAdmin();
  return { ok: true, message: t.admin.refundReconciliationQueued };
}

export async function resolveManualReviewAction(
  input: z.input<typeof baseSchema>,
): Promise<AdminReviewActionResult> {
  const t = await getDictionary();
  const actorUserId = await authorizedActor();
  if (!actorUserId) return { ok: false, message: t.admin.unauthorized };
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.admin.invalidData };
  const result = await resolveManualReview({ ...parsed.data, actorUserId });
  if (!result.ok) return { ok: false, message: t.admin.reviewActionUnsafe };
  refreshAdmin();
  return { ok: true, message: t.admin.reviewResolved };
}
