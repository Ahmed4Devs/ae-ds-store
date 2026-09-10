import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/session";
import { recognizedOrderFinancials } from "@/lib/admin-stats";
import {
  ADMIN_ORDERS_MAX_PAGE,
  ADMIN_ORDERS_PAGE_SIZE,
  parseAdminOrdersPage,
} from "@/lib/query/keys";
import type {
  AdminOrderRowDto,
  AdminOrdersDto,
  AdminStatsDto,
} from "@/lib/query/keys";

/**
 * قائمة الطلبيات وإحصاءاتها للوحة الإدارة.
 * تُستقصى دوريًا حتى يرصد المشغّل طابور المراجعة فور تغيّره.
 */
export async function GET(request: Request): Promise<NextResponse> {
  // التحقق هنا لا في التخطيط وحده: المسار قابل للاستدعاء مباشرةً
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const keys = [...searchParams.keys()];
  if (
    keys.some(
      (key) => key !== "status" && key !== "review" && key !== "page",
    ) ||
    searchParams.getAll("status").length > 1 ||
    searchParams.getAll("review").length > 1 ||
    searchParams.getAll("page").length > 1
  ) {
    return NextResponse.json(
      { error: "INVALID_PARAMS" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const statusParam = searchParams.get("status");
  const reviewParam = searchParams.get("review");
  const page = parseAdminOrdersPage(searchParams.get("page"));

  const VALID = [
    "PENDING_PAYMENT",
    "PAID",
    "SOURCING",
    "SOURCED",
    "SOURCING_FAILED",
    "SHIPPED",
    "DELIVERED",
    "CANCELLED",
  ] as const;
  type Status = (typeof VALID)[number];
  if (
    (statusParam !== null &&
      !(VALID as readonly string[]).includes(statusParam)) ||
    (reviewParam !== null && reviewParam !== "true") ||
    page === null
  ) {
    return NextResponse.json(
      { error: "INVALID_PARAMS" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const status =
    statusParam && (VALID as readonly string[]).includes(statusParam)
      ? (statusParam as Status)
      : undefined;
  const review = reviewParam === "true";

  const where =
    status || review
      ? {
          ...(status ? { status } : {}),
          ...(review ? { needsManualReview: true } : {}),
        }
      : undefined;

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
    // سعر الصرف المثبَّت على الطلبية لا السعر الحالي
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

  const response: AdminOrdersDto = {
    rows,
    stats,
    totalFiltered,
    hasNext:
      page < ADMIN_ORDERS_MAX_PAGE &&
      page * ADMIN_ORDERS_PAGE_SIZE < totalFiltered,
  };

  return NextResponse.json(
    response,
    { headers: { "Cache-Control": "no-store" } },
  );
}
