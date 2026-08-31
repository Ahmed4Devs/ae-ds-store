"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retrySourcingAction, syncOrdersAction } from "@/app/actions/admin";
import { Button } from "@/components/ui";

export function RetrySourcingButton({
  orderId,
  labels,
}: {
  orderId: string;
  labels: { retry: string; retrying: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await retrySourcingAction({ orderId });
            setMsg({ ok: res.ok, text: res.message });
            router.refresh();
          })
        }
      >
        {pending ? labels.retrying : labels.retry}
      </Button>
      {msg && (
        <p
          className={
            "max-w-xs text-xs leading-relaxed " +
            (msg.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400")
          }
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

export function SyncOrdersButton({
  labels,
}: {
  labels: { sync: string; syncing: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await syncOrdersAction();
            setMsg(res.message);
            router.refresh();
          })
        }
      >
        {pending ? labels.syncing : labels.sync}
      </Button>
      {msg && <span className="text-xs text-ink-500">{msg}</span>}
    </div>
  );
}
