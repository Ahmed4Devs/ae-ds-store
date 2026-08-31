import { Badge } from "@/components/ui";
import type { Dictionary } from "@/lib/i18n/shared";

type StatusLabels = Dictionary["orders"]["status"];
type StepLabels = Dictionary["orders"]["steps"];

const TONES: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  PENDING_PAYMENT: "warning",
  PAID: "info",
  SOURCING: "info",
  SOURCED: "info",
  SOURCING_FAILED: "danger",
  SHIPPED: "success",
  DELIVERED: "success",
  CANCELLED: "neutral",
};

export function OrderStatusBadge({
  status,
  labels,
}: {
  status: string;
  labels: StatusLabels;
}) {
  const label = labels[status as keyof StatusLabels] ?? status;
  return <Badge tone={TONES[status] ?? "neutral"}>{label}</Badge>;
}

export function orderStatusLabel(status: string, labels: StatusLabels): string {
  return labels[status as keyof StatusLabels] ?? status;
}

/** ترتيب خطوات تقدّم الطلبية المعروضة للعميل. */
const ORDER_RANK: Record<string, number> = {
  PENDING_PAYMENT: 0,
  PAID: 1,
  SOURCING: 1,
  SOURCED: 2,
  SOURCING_FAILED: 1,
  SHIPPED: 3,
  DELIVERED: 4,
  CANCELLED: 0,
};

export function OrderProgress({
  status,
  labels,
}: {
  status: string;
  labels: StepLabels;
}) {
  const rank = ORDER_RANK[status] ?? 0;
  if (status === "CANCELLED") return null;

  const steps = [
    labels.confirm,
    labels.preparing,
    labels.shipping,
    labels.delivered,
  ];

  return (
    <ol className="flex items-center">
      {steps.map((label, i) => {
        const done = rank >= i + 1;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={
                  "grid size-8 place-items-center rounded-full text-xs font-bold transition " +
                  (done
                    ? "bg-brand-600 text-white"
                    : "bg-ink-200 text-ink-500 dark:bg-ink-700")
                }
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={
                  "text-[11px] whitespace-nowrap " +
                  (done ? "font-medium" : "text-ink-500")
                }
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={
                  "mx-1 mb-5 h-0.5 flex-1 " +
                  (rank >= i + 2 ? "bg-brand-600" : "bg-ink-200 dark:bg-ink-700")
                }
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
