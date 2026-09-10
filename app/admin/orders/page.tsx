import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { orderStatusLabel } from "@/components/order-status";
import { AdminOrdersTable } from "@/components/admin-orders-table";
import { prisma } from "@/lib/db";
import { recognizedOrderFinancials } from "@/lib/admin-stats";
import { getDictionary, getLocale } from "@/lib/i18n";
import { getQueryClient } from "@/lib/query/client";
import {
  ADMIN_ORDERS_MAX_PAGE,
  ADMIN_ORDERS_PAGE_SIZE,
  parseAdminOrdersPage,
  queryKeys,
} from "@/lib/query/keys";
import type {
  AdminOrderRowDto,
  AdminOrdersDto,
  AdminStatsDto,
} from "@/lib/query/keys";

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
  if (
    Object.keys(sp).some(
      (key) => key !== "status" && key !== "review" && key !== "page",
    ) ||
    Array.isArray(sp.status) ||
    Array.isArray(sp.review) ||
    Array.isArray(sp.page)
  ) {
    notFound();
  }
  const statusParam = typeof sp.status === "string" ? sp.status : undefined;
  if (statusParam !== undefined && !isStatus(statusParam)) notFound();
  const reviewParam = typeof sp.review === "string" ? sp.review : undefined;
  if (sp.review !== undefined && reviewParam !== "true") notFound();
  const pageParam = typeof sp.page === "string" ? sp.page : undefined;
  const page = parseAdminOrdersPage(pageParam);
  if (page === null) notFound();
  const status = statusParam && isStatus(statusParam) ? statusParam : undefined;
  const review = reviewParam === "true";

  const where =
    status || review
      ? {
          ...(status ? { status } : {}),
          ...(review ? { needsManualReview: true } : {}),
        }
      : undefined;

  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

  const [
    orders,
    totalFiltered,
    totalOrders,
    needsAttention,
    financials,
    failedCalls,
    fatalCalls,
  ] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * ADMIN_ORDERS_PAGE_SIZE,
        take: ADMIN_ORDERS_PAGE_SIZE,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          needsManualReview: true,
          manualReviewCode: true,
          manualReviewOpenedAt: true,
          totalSar: true,
          costSubtotal: true,
          costShipping: true,
          fxRateUsed: true,
          refundedAt: true,
          createdAt: true,
          _count: { select: { items: true, aeOrders: true } },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.count(),
      prisma.order.count({ where: { needsManualReview: true } }),
      recognizedOrderFinancials(),
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
      needsManualReview: o.needsManualReview,
      manualReviewCode:
        o.needsManualReview && o.manualReviewCode
          ? o.manualReviewCode.slice(0, 100)
          : null,
      manualReviewOpenedAt:
        o.needsManualReview && o.manualReviewOpenedAt
          ? o.manualReviewOpenedAt.toISOString()
          : null,
      totalSar: Number(o.totalSar),
      costSar,
      marginSar: (o.refundedAt ? 0 : Number(o.totalSar)) - costSar,
      itemCount: o._count.items,
      aeOrderCount: o._count.aeOrders,
      createdAt: o.createdAt.toISOString(),
    };
  });

  const stats: AdminStatsDto = {
    totalOrders,
    needsAttention,
    revenueSar: financials.revenueSar,
    grossMarginSar: financials.grossMarginSar,
    failedCalls,
    fatalCalls,
  };

  const initialData: AdminOrdersDto = {
    rows,
    stats,
    totalFiltered,
    hasNext:
      page < ADMIN_ORDERS_MAX_PAGE &&
      page * ADMIN_ORDERS_PAGE_SIZE < totalFiltered,
  };

  const queryClient = getQueryClient();
  queryClient.setQueryData(
    queryKeys.adminOrders(status, review, page),
    initialData,
  );

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold">{t.admin.orders}</h1>

      <div className="mb-5 flex flex-wrap gap-2">
        <Link
          href="/admin/orders"
          className={
            "rounded-full border px-3.5 py-1.5 text-sm " +
            (!status && !review
              ? "border-brand-600 bg-brand-600 text-white"
              : "border-(--color-border-app) hover:border-brand-400")
          }
        >
          {t.common.all}
        </Link>
        <Link
          href="/admin/orders?review=true"
          className={
            "rounded-full border px-3.5 py-1.5 text-sm " +
            (review
              ? "border-red-600 bg-red-600 text-white"
              : "border-(--color-border-app) hover:border-red-400")
          }
        >
          {t.admin.manualReviewFilter}
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
          review={review}
          page={page}
          initialData={initialData}
          locale={locale}
          labels={t.admin}
          statusLabels={t.orders.status}
        />
      </HydrationBoundary>
    </>
  );
}
