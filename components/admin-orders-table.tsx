"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import { OrderStatusBadge } from "@/components/order-status";
import { useAdminOrders } from "@/lib/query/hooks";
import { formatSar } from "@/lib/pricing/format";
import { formatDateAr } from "@/lib/ksa";
import { fill, type Dictionary, type Locale } from "@/lib/i18n/shared";
import type { AdminOrdersDto } from "@/lib/query/keys";

const ADMIN_ORDERS_STALE_AFTER_MS = 2 * 60_000;

/**
 * جدول طلبيات الإدارة مع تحديث دوري.
 * الغرض التشغيلي: رصد حالات المراجعة فور حدوثها دون إعادة تحميل يدوي.
 */
export function AdminOrdersTable({
  status,
  review,
  page,
  initialData,
  locale,
  labels,
  statusLabels,
}: {
  status?: string;
  review: boolean;
  page: number;
  initialData: AdminOrdersDto;
  locale: Locale;
  labels: Dictionary["admin"];
  statusLabels: Dictionary["orders"]["status"];
}) {
  const { data, isError, isFetching, dataUpdatedAt } = useAdminOrders(
    status,
    review,
    page,
    initialData,
  );
  const rows = data?.rows ?? initialData.rows;
  const stats = data?.stats ?? initialData.stats;
  const totalFiltered = data?.totalFiltered ?? initialData.totalFiltered;
  const hasNext = data?.hasNext ?? initialData.hasNext;
  const [now, setNow] = useState(0);

  useEffect(() => {
    const refreshClock = () => setNow(Date.now());
    refreshClock();
    const timer = window.setInterval(refreshClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const isStale =
    now > 0 &&
    dataUpdatedAt > 0 &&
    now - dataUpdatedAt > ADMIN_ORDERS_STALE_AFTER_MS;
  const updateLabel = isError
    ? labels.pollingFailed
    : isStale
      ? labels.pollingStale
      : labels.liveUpdating;

  function pageHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (review) params.set("review", "true");
    if (targetPage > 1) params.set("page", String(targetPage));
    const query = params.toString();
    return `/admin/orders${query ? `?${query}` : ""}`;
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-500">
        <span className="flex items-center gap-1.5" role="status" aria-live="polite">
          <span
            className={
              "size-2 rounded-full " +
              (isError
                ? "bg-red-500"
                : isStale
                  ? "bg-amber-500"
                  : isFetching
                    ? "animate-pulse bg-brand-500"
                    : "bg-emerald-500")
            }
          />
          {updateLabel}
        </span>
        <span className="nums">
          {fill(labels.lastSuccessfulUpdate, {
            time: formatDateAr(new Date(dataUpdatedAt), locale),
          })}
        </span>
      </div>

      {(isError || isStale) && (
        <div
          role={isError ? "alert" : "status"}
          className={
            "mb-4 rounded-lg border p-3 text-sm " +
            (isError
              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
              : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200")
          }
        >
          {isError ? labels.pollingFailedBody : labels.pollingStaleBody}
        </div>
      )}

      {stats.needsAttention > 0 && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          {fill(labels.needsAttention, { n: stats.needsAttention })}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title={labels.noOrders} description={labels.noOrdersFilter} />
      ) : (
        <Card className="overflow-hidden">
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-(--color-background) text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">
                    {labels.colOrderNumber}
                  </th>
                  <th className="px-4 py-2.5 text-start font-medium">{labels.colDate}</th>
                  <th className="px-4 py-2.5 text-start font-medium">
                    {labels.colProducts}
                  </th>
                  <th className="px-4 py-2.5 text-start font-medium">
                    {labels.colAeOrders}
                  </th>
                  <th className="px-4 py-2.5 text-start font-medium">{labels.colCost}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{labels.colTotal}</th>
                  <th className="px-4 py-2.5 text-start font-medium">
                    {labels.colMargin}
                  </th>
                  <th className="px-4 py-2.5 text-start font-medium">
                    {labels.colStatus}
                  </th>
                  <th className="px-4 py-2.5 text-start font-medium">
                    {labels.colReview}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-(--color-border-app)">
                {rows.map((o) => (
                  <tr key={o.id} className="hover:bg-(--color-background)">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/orders/${o.orderNumber}`}
                        className="nums font-medium text-brand-600 hover:underline"
                        dir="ltr"
                      >
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-500">
                      {formatDateAr(o.createdAt, locale)}
                    </td>
                    <td className="nums px-4 py-3">{o.itemCount}</td>
                    <td className="nums px-4 py-3">{o.aeOrderCount}</td>
                    <td className="nums px-4 py-3 text-ink-500">
                      {formatSar(o.costSar, locale)}
                    </td>
                    <td className="nums px-4 py-3 font-medium">
                      {formatSar(o.totalSar, locale)}
                    </td>
                    <td
                      className={
                        "nums px-4 py-3 font-medium " +
                        (o.marginSar >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400")
                      }
                    >
                      {formatSar(o.marginSar, locale)}
                    </td>
                    <td className="px-4 py-3">
                      <OrderStatusBadge status={o.status} labels={statusLabels} />
                    </td>
                    <td className="px-4 py-3">
                      {o.needsManualReview ? (
                        <div className="space-y-1">
                          <Badge tone="danger">{labels.manualReviewBadge}</Badge>
                          {o.manualReviewCode && (
                            <code
                              className="block max-w-48 truncate font-mono text-xs text-ink-600 dark:text-ink-300"
                              dir="ltr"
                              title={o.manualReviewCode}
                            >
                              {o.manualReviewCode}
                            </code>
                          )}
                          {o.manualReviewOpenedAt && (
                            <span className="block whitespace-nowrap text-xs text-ink-500">
                              {fill(labels.manualReviewOpenedAt, {
                                date: formatDateAr(o.manualReviewOpenedAt, locale),
                              })}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-ink-400">{labels.noManualReview}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(totalFiltered > 0 || page > 1) && (
        <nav
          className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"
          aria-label={labels.paginationLabel}
        >
          <span className="text-ink-500">
            {fill(labels.ordersPageSummary, {
              shown: rows.length,
              total: totalFiltered,
            })}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link
                href={pageHref(page - 1)}
                className="rounded-lg border border-(--color-border-app) px-3 py-1.5 hover:border-brand-400"
              >
                {labels.previousPage}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="rounded-lg border border-(--color-border-app) px-3 py-1.5 text-ink-400"
              >
                {labels.previousPage}
              </span>
            )}
            <span className="nums px-2 text-ink-500">
              {fill(labels.pageNumber, { page })}
            </span>
            {hasNext ? (
              <Link
                href={pageHref(page + 1)}
                className="rounded-lg border border-(--color-border-app) px-3 py-1.5 hover:border-brand-400"
              >
                {labels.nextPage}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="rounded-lg border border-(--color-border-app) px-3 py-1.5 text-ink-400"
              >
                {labels.nextPage}
              </span>
            )}
          </div>
        </nav>
      )}
    </>
  );
}
