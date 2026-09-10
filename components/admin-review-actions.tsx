"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  attachReviewedSupplierOrdersAction,
  reconcileReviewedRefundAction,
  resolveManualReviewAction,
  retryReviewedSourcingAction,
} from "@/app/actions/admin-review";
import { Alert, Button, Field, Input, Textarea } from "@/components/ui";

export function AdminReviewActions({
  orderId,
  canRetrySourcing,
  canAttachSupplier,
  canReconcileRefund,
  canResolve,
  labels,
}: {
  orderId: string;
  canRetrySourcing: boolean;
  canAttachSupplier: boolean;
  canReconcileRefund: boolean;
  canResolve: boolean;
  labels: {
    reviewActionsTitle: string;
    reviewReason: string;
    reviewRetrySource: string;
    reviewAttachSupplier: string;
    reviewSupplierIds: string;
    reviewReconcileRefund: string;
    reviewRefundRef: string;
    reviewResolve: string;
    reviewWorking: string;
  };
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [supplierIds, setSupplierIds] = useState("");
  const [refundRef, setRefundRef] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const reasonReady = reason.trim().length >= 3;

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action();
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-red-300 bg-(--color-surface) p-4 dark:border-red-800">
      <p className="font-semibold">{labels.reviewActionsTitle}</p>
      <div className="mt-3 space-y-4">
        <Field label={labels.reviewReason} required>
          <Textarea
            value={reason}
            minLength={3}
            maxLength={500}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        {canAttachSupplier && (
          <Field label={labels.reviewSupplierIds} required>
            <Input
              value={supplierIds}
              maxLength={400}
              dir="ltr"
              disabled={pending}
              onChange={(event) => setSupplierIds(event.target.value)}
            />
          </Field>
        )}
        {canReconcileRefund && (
          <Field label={labels.reviewRefundRef} required>
            <Input
              value={refundRef}
              maxLength={160}
              dir="ltr"
              disabled={pending}
              onChange={(event) => setRefundRef(event.target.value)}
            />
          </Field>
        )}

        <div className="flex flex-wrap gap-2">
          {canRetrySourcing && (
            <Button
              size="sm"
              disabled={pending || !reasonReady}
              onClick={() =>
                run(() => retryReviewedSourcingAction({ orderId, reason }))
              }
            >
              {pending ? labels.reviewWorking : labels.reviewRetrySource}
            </Button>
          )}
          {canAttachSupplier && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !reasonReady || supplierIds.trim().length < 5}
              onClick={() =>
                run(() =>
                  attachReviewedSupplierOrdersAction({
                    orderId,
                    reason,
                    aeOrderIds: supplierIds,
                  }),
                )
              }
            >
              {pending ? labels.reviewWorking : labels.reviewAttachSupplier}
            </Button>
          )}
          {canReconcileRefund && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !reasonReady || refundRef.trim().length < 5}
              onClick={() =>
                run(() =>
                  reconcileReviewedRefundAction({
                    orderId,
                    reason,
                    providerRefundRef: refundRef,
                  }),
                )
              }
            >
              {pending ? labels.reviewWorking : labels.reviewReconcileRefund}
            </Button>
          )}
          {canResolve && (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending || !reasonReady}
              onClick={() =>
                run(() => resolveManualReviewAction({ orderId, reason }))
              }
            >
              {pending ? labels.reviewWorking : labels.reviewResolve}
            </Button>
          )}
        </div>

        {message && (
          <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert>
        )}
      </div>
    </div>
  );
}
