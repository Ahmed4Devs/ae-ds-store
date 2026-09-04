"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adminCancelOrderAction } from "@/app/actions/order";
import { confirmManualPaymentAction } from "@/app/actions/payment";
import { Alert, Button, Field, Textarea } from "@/components/ui";

/**
 * إجراءات المسؤول على الطلبية: الإلغاء والتأكيد اليدوي للدفع.
 *
 * الاثنان في مكوّن واحد لأنهما يتشاركان الرسالة المعروضة: تأكيد الدفع يبدأ
 * التوريد فورًا، فلا يصحّ أن يبقى زرّ الإلغاء يبدو متاحًا بجواره برسالة قديمة.
 */
export function AdminOrderActions({
  orderId,
  settleableIntentId,
  labels,
}: {
  orderId: string;
  /** نيّة الدفع القابلة للتأكيد يدويًا — null إن لم توجد أو كان المزوّد غير يدوي */
  settleableIntentId: string | null;
  labels: {
    cancelCta: string;
    cancelTitle: string;
    cancelBody: string;
    cancelReason: string;
    cancelConfirm: string;
    cancelling: string;
    close: string;
    confirmPayment: string;
    confirmingPayment: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run(fn: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const res = await fn();
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {settleableIntentId && (
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() =>
                confirmManualPaymentAction({ intentId: settleableIntentId }),
              )
            }
          >
            {pending ? labels.confirmingPayment : labels.confirmPayment}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? labels.close : labels.cancelCta}
        </Button>
      </div>

      {msg && (
        <div className="w-full max-w-md">
          <Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert>
        </div>
      )}

      {open && (
        <div className="w-full max-w-md rounded-lg border border-(--color-border-app) bg-(--color-surface) p-4 text-start">
          <p className="font-semibold">{labels.cancelTitle}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            {labels.cancelBody}
          </p>
          <div className="mt-3">
            <Field label={labels.cancelReason}>
              <Textarea
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                disabled={pending}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(() =>
                  adminCancelOrderAction({
                    orderId,
                    reason: reason.trim() || undefined,
                  }),
                )
              }
            >
              {pending ? labels.cancelling : labels.cancelConfirm}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
