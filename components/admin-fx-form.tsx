"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setFxRateAction } from "@/app/actions/admin-settings";
import { Button, Field, Input } from "@/components/ui";
import type { Dictionary } from "@/lib/i18n/shared";

/**
 * تسجيل سعر صرف جديد.
 *
 * الحقل رقمي بخطوة صغيرة عمدًا: الفرق بين 3.75 و3.85 يساوي عشرات
 * الريالات على سلة متوسطة، فالتقريب إلى منزلة واحدة غير مقبول هنا.
 * والتحقق النهائي من النطاق يبقى في الخادم — هذا الحقل تسهيل لا حماية.
 */
export function AdminFxForm({
  labels,
  commonLabels,
  currentRate,
}: {
  labels: Dictionary["admin"];
  commonLabels: Dictionary["common"];
  currentRate: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rate, setRate] = useState(currentRate.toFixed(4));
  const [source, setSource] = useState("manual");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const value = Number(rate);

        if (!Number.isFinite(value)) {
          setMsg({ ok: false, text: labels.fxInvalid });
          return;
        }

        startTransition(async () => {
          const res = await setFxRateAction({
            rate: value,
            source: source.trim() || "manual",
          });
          setMsg({ ok: res.ok, text: res.message });
          router.refresh();
        });
      }}
    >
      <Field label={labels.fxNewRate}>
        <Input
          className="nums"
          type="number"
          step={0.0001}
          min={1}
          max={10}
          inputMode="decimal"
          dir="ltr"
          value={rate}
          disabled={pending}
          onChange={(e) => setRate(e.target.value)}
        />
      </Field>

      <Field label={labels.fxSource}>
        <Input
          value={source}
          disabled={pending}
          placeholder={labels.fxSourcePlaceholder}
          onChange={(e) => setSource(e.target.value)}
        />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? commonLabels.saving : labels.fxSave}
      </Button>

      {msg && (
        <p
          className={
            "text-sm sm:col-span-3 " +
            (msg.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400")
          }
        >
          {msg.text}
        </p>
      )}
    </form>
  );
}
