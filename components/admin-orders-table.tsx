"use client";

import Link from "next/link";
import { Card, EmptyState } from "@/components/ui";
import { OrderStatusBadge } from "@/components/order-status";
import { useAdminOrders } from "@/lib/query/hooks";
import { formatSar } from "@/lib/pricing";
import { formatDateAr } from "@/lib/ksa";
import { fill, type Dictionary, type Locale } from "@/lib/i18n/shared";
import type { AdminOrderRowDto, AdminStatsDto } from "@/lib/query/keys";

/**
 * جدول طلبيات الإدارة مع تحديث دوري.
 * الغرض التشغيلي: رصد الطلبيات الفاشلة فور حدوثها دون إعادة تحميل يدوي.
 */
export function AdminOrdersTable({
  status,
  initialData,
  locale,
  labels,
  statusLabels,
}: {
  status?: string;
  initialData: { rows: AdminOrderRowDto[]; stats: AdminStatsDto };
  locale: Locale;
  labels: Dictionary["admin"];
  statusLabels: Dictionary["orders"]["status"];
}) {
  const { data, isFetching, dataUpdatedAt } = useAdminOrders(status, initialData);
  const rows = data?.rows ?? initialData.rows;
  const stats = data?.stats ?? initialData.stats;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-500">
        <span className="flex items-center gap-1.5">
          <span
            className={
              "size-2 rounded-full " +
              (isFetching ? "animate-pulse bg-brand-500" : "bg-emerald-500")
            }
          />
          {labels.liveUpdating}
        </span>
        <span className="nums">
          {fill(labels.lastChecked, {
            time: formatDateAr(new Date(dataUpdatedAt), locale),
          })}
        </span>
      </div>

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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
