"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestFullRefundAction } from "@/app/actions/admin-review";
import { Alert, Button, Field, Select, Textarea } from "@/components/ui";

type ProviderReason = "duplicate" | "fraudulent" | "requested_by_customer";

export function AdminRefundAction({
  orderId,
  labels,
}: {
  orderId: string;
  labels: {
    refundCta: string;
    refundTitle: string;
    refundBody: string;
    refundReasonLabel: string;
    refundProviderReasonLabel: string;
    refundReasonCustomer: string;
    refundReasonDuplicate: string;
    refundReasonFraud: string;
    refundConfirm: string;
    refunding: string;
    close: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [providerReason, setProviderReason] =
    useState<ProviderReason>("requested_by_customer");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  function submit() {
    startTransition(async () => {
      const result = await requestFullRefundAction({
        orderId,
        reason,
        providerReason,
      });
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-3">
      <Button
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? labels.close : labels.refundCta}
      </Button>

      {message && (
        <div className="w-full max-w-md">
          <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert>
        </div>
      )}

      {open && (
        <div className="w-full max-w-md rounded-lg border border-red-300 bg-(--color-surface) p-4 text-start dark:border-red-800">
          <p className="font-semibold">{labels.refundTitle}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            {labels.refundBody}
          </p>
          <div className="mt-3 space-y-3">
            <Field label={labels.refundReasonLabel} required>
              <Textarea
                value={reason}
                minLength={3}
                maxLength={500}
                disabled={pending}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Field label={labels.refundProviderReasonLabel} required>
              <Select
                value={providerReason}
                disabled={pending}
                onChange={(event) =>
                  setProviderReason(event.target.value as ProviderReason)
                }
              >
                <option value="requested_by_customer">
                  {labels.refundReasonCustomer}
                </option>
                <option value="duplicate">{labels.refundReasonDuplicate}</option>
                <option value="fraudulent">{labels.refundReasonFraud}</option>
              </Select>
            </Field>
            <Button
              variant="danger"
              size="sm"
              disabled={pending || reason.trim().length < 3}
              onClick={submit}
            >
              {pending ? labels.refunding : labels.refundConfirm}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
