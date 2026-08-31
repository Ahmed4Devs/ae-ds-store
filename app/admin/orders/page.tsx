import Link from "next/link";
import { Card, EmptyState } from "@/components/ui";
import { OrderStatusBadge, orderStatusLabel } from "@/components/order-status";
import { prisma } from "@/lib/db";
import { formatSar } from "@/lib/pricing";
import { formatDateAr } from "@/lib/ksa";
import { getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.admin.orders };
}

const STATUSES = [
  "PENDING_PAYMENT",
  "PAID",
  "SOURCING",
  "SOURCED",
  "SOURCING_FAILED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;

type OrderStatusValue = (typeof STATUSES)[number];

function isStatus(v: string): v is OrderStatusValue {
  return (STATUSES as readonly string[]).includes(v);
}

export default async function AdminOrdersPage(
  props: PageProps<"/admin/orders">,
) {
  const sp = await props.searchParams;
  const statusParam = typeof sp.status === "string" ? sp.status : "";
  const status = isStatus(statusParam) ? statusParam : undefined;

  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

  const orders = await prisma.order.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalSar: true,
      costSubtotal: true,
      costShipping: true,
      fxRateUsed: true,
      createdAt: true,
      _count: { select: { items: true, aeOrders: true } },
    },
  });

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold">{t.admin.orders}</h1>

      <div className="mb-5 flex flex-wrap gap-2">
        <Link
          href="/admin/orders"
          className={
            "rounded-full border px-3.5 py-1.5 text-sm " +
            (!status
              ? "border-brand-600 bg-brand-600 text-white"
              : "border-[--color-border-app] hover:border-brand-400")
          }
        >
          {t.common.all}
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/orders?status=${s}`}
            className={
              "rounded-full border px-3.5 py-1.5 text-sm " +
              (status === s
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-[--color-border-app] hover:border-brand-400")
            }
          >
            {orderStatusLabel(s, t.orders.status)}
          </Link>
        ))}
      </div>

      {orders.length === 0 ? (
        <EmptyState title={t.admin.noOrders} description={t.admin.noOrdersFilter} />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-[--color-background] text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colOrderNumber}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colDate}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colProducts}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colAeOrders}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colCost}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colTotal}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colMargin}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colStatus}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--color-border-app]">
                {orders.map((o) => {
                  const costSar =
                    (Number(o.costSubtotal) + Number(o.costShipping)) *
                    Number(o.fxRateUsed);
                  const margin = Number(o.totalSar) - costSar;
                  return (
                    <tr key={o.id} className="hover:bg-[--color-background]">
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/orders/${o.orderNumber}`}
                          className="font-medium text-brand-600 hover:underline nums"
                          dir="ltr"
                        >
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-ink-500">
                        {formatDateAr(o.createdAt, locale)}
                      </td>
                      <td className="px-4 py-3 nums">{o._count.items}</td>
                      <td className="px-4 py-3 nums">{o._count.aeOrders}</td>
                      <td className="px-4 py-3 text-ink-500 nums">
                        {formatSar(costSar, locale)}
                      </td>
                      <td className="px-4 py-3 font-medium nums">
                        {formatSar(Number(o.totalSar), locale)}
                      </td>
                      <td
                        className={
                          "px-4 py-3 font-medium nums " +
                          (margin >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400")
                        }
                      >
                        {formatSar(margin, locale)}
                      </td>
                      <td className="px-4 py-3">
                        <OrderStatusBadge status={o.status} labels={t.orders.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
