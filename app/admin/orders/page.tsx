import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { orderStatusLabel } from "@/components/order-status";
import { AdminOrdersTable } from "@/components/admin-orders-table";
import { prisma } from "@/lib/db";
import { effectiveFxRate } from "@/lib/pricing";
import { getDictionary, getLocale } from "@/lib/i18n";
import { getQueryClient } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import type { AdminOrderRowDto, AdminStatsDto } from "@/lib/query/keys";

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
  // حارس ذاتي — لا يُكتفى بحماية التخطيط (راجع requireAdmin). يسبق كل قراءة.
  await requireAdmin();
  const sp = await props.searchParams;
  if (Object.keys(sp).some((key) => key !== "status") || Array.isArray(sp.status)) {
    notFound();
  }
  const statusParam = typeof sp.status === "string" ? sp.status : "";
  if (statusParam && !isStatus(statusParam)) notFound();
  const status = isStatus(statusParam) ? statusParam : undefined;

  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

  const [orders, totalOrders, needsAttention, revenue, failedCalls, fatalCalls] =
    await Promise.all([
      prisma.order.findMany({
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
      }),
      prisma.order.count(),
      prisma.order.count({ where: { status: "SOURCING_FAILED" } }),
      prisma.order.aggregate({
        _sum: { totalSar: true, costSubtotal: true, costShipping: true },
        where: { status: { in: ["SOURCED", "SHIPPED", "DELIVERED"] } },
      }),
      prisma.aeApiLog.count({ where: { success: false } }),
      prisma.aeApiLog.count({ where: { success: false, retryable: false } }),
    ]);

  const rows: AdminOrderRowDto[] = orders.map((o) => {
    const costSar =
      (Number(o.costSubtotal) + Number(o.costShipping)) * Number(o.fxRateUsed);
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      totalSar: Number(o.totalSar),
      costSar,
      marginSar: Number(o.totalSar) - costSar,
      itemCount: o._count.items,
      aeOrderCount: o._count.aeOrders,
      createdAt: o.createdAt.toISOString(),
    };
  });

  const revenueSar = Number(revenue._sum.totalSar ?? 0);
  const costSourceTotal =
    Number(revenue._sum.costSubtotal ?? 0) + Number(revenue._sum.costShipping ?? 0);

  const stats: AdminStatsDto = {
    totalOrders,
    needsAttention,
    revenueSar,
    grossMarginSar: revenueSar - costSourceTotal * effectiveFxRate(),
    failedCalls,
    fatalCalls,
  };

  const initialData = { rows, stats };

  const queryClient = getQueryClient();
  queryClient.setQueryData(queryKeys.adminOrders(status), initialData);

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
              : "border-(--color-border-app) hover:border-brand-400")
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
                : "border-(--color-border-app) hover:border-brand-400")
            }
          >
            {orderStatusLabel(s, t.orders.status)}
          </Link>
        ))}
      </div>

      <HydrationBoundary state={dehydrate(queryClient)}>
        <AdminOrdersTable
          status={status}
          initialData={initialData}
          locale={locale}
          labels={t.admin}
          statusLabels={t.orders.status}
        />
      </HydrationBoundary>
    </>
  );
}
