"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelOrderAction } from "@/app/actions/order";
import { Alert, Button, Card, Field, Textarea } from "@/components/ui";

/**
 * إلغاء الطلب من صفحة العميل.
 *
 * الإلغاء مخفيّ خلف كشف (disclosure) لا زرّ ظاهر: هذا الإجراء لا رجعة فيه،
 * ووضعه بجوار بقية أزرار الصفحة يجعل النقر الخاطئ سهلًا.
 */
export function CancelOrder({
  orderNumber,
  labels,
}: {
  orderNumber: string;
  labels: {
    cta: string;
    title: string;
    body: string;
    reason: string;
    reasonPlaceholder: string;
    submit: string;
    submitting: string;
    close: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) {
    return (
      <div className="mt-6 flex justify-center">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {labels.cta}
        </Button>
      </div>
    );
  }

  return (
    <Card className="mt-6 p-5">
      <p className="font-semibold">{labels.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-500">{labels.body}</p>

      <div className="mt-4">
        <Field label={labels.reason}>
          <Textarea
            value={reason}
            maxLength={500}
            placeholder={labels.reasonPlaceholder}
            onChange={(e) => setReason(e.target.value)}
            disabled={pending}
          />
        </Field>
      </div>

      {msg && (
        <div className="mt-4">
          <Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          variant="danger"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await cancelOrderAction({
                orderNumber,
                reason: reason.trim() || undefined,
              });
              setMsg({ ok: res.ok, text: res.message });
              // التحديث يعيد رسم الصفحة بحالة CANCELLED، فيختفي هذا النموذج
              if (res.ok) router.refresh();
            })
          }
        >
          {pending ? labels.submitting : labels.submit}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          {labels.close}
        </Button>
      </div>
    </Card>
  );
}
