import { Badge } from "@/components/ui";

/** ترجمة حالات الطلبية مع نبرة لونية مناسبة. */
const STATUS_MAP: Record<
  string,
  { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }
> = {
  PENDING_PAYMENT: { label: "بانتظار الدفع", tone: "warning" },
  PAID: { label: "تم الدفع", tone: "info" },
  SOURCING: { label: "جارٍ التوريد", tone: "info" },
  SOURCED: { label: "قيد التجهيز", tone: "info" },
  SOURCING_FAILED: { label: "يحتاج مراجعة", tone: "danger" },
  SHIPPED: { label: "تم الشحن", tone: "success" },
  DELIVERED: { label: "تم التسليم", tone: "success" },
  CANCELLED: { label: "ملغاة", tone: "neutral" },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const s = STATUS_MAP[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function orderStatusLabel(status: string): string {
  return STATUS_MAP[status]?.label ?? status;
}

/** خطوات تقدّم الطلبية المعروضة للعميل. */
const STEPS = [
  { key: "PAID", label: "تأكيد الطلب" },
  { key: "SOURCED", label: "التجهيز" },
  { key: "SHIPPED", label: "الشحن" },
  { key: "DELIVERED", label: "التسليم" },
] as const;

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

export function OrderProgress({ status }: { status: string }) {
  const rank = ORDER_RANK[status] ?? 0;
  if (status === "CANCELLED") return null;

  return (
    <ol className="flex items-center">
      {STEPS.map((step, i) => {
        const done = rank >= i + 1;
        return (
          <li key={step.key} className="flex flex-1 items-center last:flex-none">
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
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
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
