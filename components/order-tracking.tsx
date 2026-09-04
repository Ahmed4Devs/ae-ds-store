"use client";

import { Alert, Badge, Card } from "@/components/ui";
import { OrderProgress, OrderStatusBadge } from "@/components/order-status";
import { useOrderTracking } from "@/lib/query/hooks";
import { fill, type Dictionary, type Locale } from "@/lib/i18n/shared";
import { formatDateAr } from "@/lib/ksa";
import type { OrderTrackingDto } from "@/lib/query/keys";

/**
 * يقبل رابط شركة الشحن فقط إن كان http/https.
 *
 * رابط cpWebsiteUrl مصدره بيانات تتبّع AliExpress (طرف ثالث)، ويُعرض كـ
 * href. من دون التحقق من المخطّط قد يحمل javascript: أو data:. تهريب
 * React يعطّل التنفيذ، لكن التحقق هنا دفاع صريح لا يعتمد على سلوك الإطار.
 */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * تتبّع الطلبية مع تحديث تلقائي.
 *
 * سبب الاستقصاء موثّق في مرجع الواجهات: AliExpress لا توفّر إشعارات
 * فورية، فلا سبيل لرصد تغيّر الحالة سوى السؤال الدوري. البيانات الأولى
 * تأتي مُرطَّبة من الخادم فلا تظهر شاشة تحميل.
 */
export function OrderTracking({
  orderNumber,
  initialData,
  locale,
  labels,
  steps,
  statusLabels,
}: {
  orderNumber: string;
  initialData: OrderTrackingDto;
  locale: Locale;
  labels: Dictionary["orders"];
  steps: Dictionary["orders"]["steps"];
  statusLabels: Dictionary["orders"]["status"];
}) {
  const { data, isFetching, dataUpdatedAt, refetch } = useOrderTracking(
    orderNumber,
    initialData,
  );

  const tracking = data ?? initialData;
  const packages = tracking.packages;
  const isActive = !["DELIVERED", "CANCELLED"].includes(tracking.status);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <OrderStatusBadge status={tracking.status} labels={statusLabels} />

        <div className="flex items-center gap-3 text-xs text-ink-500">
          {isActive && (
            <span className="flex items-center gap-1.5">
              <span
                className={
                  "size-2 rounded-full " +
                  (isFetching ? "animate-pulse bg-brand-500" : "bg-emerald-500")
                }
              />
              {labels.liveUpdating}
            </span>
          )}
          <span className="nums">
            {fill(labels.lastChecked, {
              time: formatDateAr(new Date(dataUpdatedAt), locale),
            })}
          </span>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="rounded-lg border border-(--color-border-app) px-2.5 py-1 transition hover:border-brand-400 disabled:opacity-50"
          >
            {labels.refreshNow}
          </button>
        </div>
      </div>

      {tracking.status === "SOURCING_FAILED" && (
        <div className="mb-6">
          <Alert tone="warning" title={labels.failedTitle}>
            {labels.failedBody}
          </Alert>
        </div>
      )}

      <Card className="mb-6 p-6">
        <OrderProgress status={tracking.status} labels={steps} />
      </Card>

      {packages.length > 0 ? (
        <Card className="mb-6 p-5">
          <p className="mb-4 font-semibold">{labels.tracking}</p>
          <div className="space-y-6">
            {packages.map((pkg) => (
              <div key={pkg.mailNo}>
                <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-ink-500">{labels.trackingNumber}</span>
                  <code
                    className="nums rounded bg-(--color-background) px-2 py-1 font-mono text-xs"
                    dir="ltr"
                  >
                    {pkg.mailNo}
                  </code>
                  {safeHttpUrl(pkg.cpWebsiteUrl) && (
                    <a
                      href={safeHttpUrl(pkg.cpWebsiteUrl)!}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {fill(labels.trackAt, {
                        carrier: pkg.cpName ?? pkg.carrierName ?? "—",
                      })}{" "}
                      ↗
                    </a>
                  )}
                  {pkg.carrierName && <Badge tone="neutral">{pkg.carrierName}</Badge>}
                </div>

                {pkg.etaAt && (
                  <p className="mb-3 text-xs text-ink-500">
                    {fill(labels.eta, { date: formatDateAr(pkg.etaAt, locale) })}
                  </p>
                )}

                <ol className="relative space-y-4 border-(--color-border-app) ps-5 ltr:border-l-2 rtl:border-r-2">
                  {pkg.nodes.map((n, i) => (
                    <li key={`${n.at}-${i}`} className="relative">
                      <span
                        className={
                          "absolute top-1 size-3 rounded-full ring-4 ring-(--color-surface) ltr:-left-[27px] rtl:-right-[27px] " +
                          (i === 0 ? "bg-brand-600" : "bg-ink-300 dark:bg-ink-600")
                        }
                      />
                      <p className="text-sm font-medium">{n.title}</p>
                      {n.description && (
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                          {n.description}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-ink-400">
                        {formatDateAr(n.at, locale)}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        tracking.status !== "PENDING_PAYMENT" && (
          <div className="mb-6">
            <Alert tone="info" title={labels.notShippedTitle}>
              {labels.notShippedBody}
            </Alert>
          </div>
        )
      )}
    </>
  );
}
