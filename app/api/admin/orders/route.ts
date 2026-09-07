import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/session";
import { effectiveFxRate } from "@/lib/pricing";
import type { AdminOrderRowDto, AdminStatsDto } from "@/lib/query/keys";

/**
 * قائمة الطلبيات وإحصاءاتها للوحة الإدارة.
 * تُستقصى دوريًا حتى يرصد المشغّل الطلبيات الفاشلة فور حدوثها.
 */
export async function GET(request: Request): Promise<NextResponse> {
  // التحقق هنا لا في التخطيط وحده: المسار قابل للاستدعاء مباشرةً
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => key !== "status") ||
    searchParams.getAll("status").length > 1
  ) {
    return NextResponse.json(
      { error: "INVALID_PARAMS" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const statusParam = searchParams.get("status");

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
  if (statusParam !== null && !(VALID as readonly string[]).includes(statusParam)) {
    return NextResponse.json(
      { error: "INVALID_PARAMS" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const status =
    statusParam && (VALID as readonly string[]).includes(statusParam)
      ? (statusParam as Status)
      : undefined;

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
    // سعر الصرف المثبَّت على الطلبية لا السعر الحالي
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

  return NextResponse.json(
    { rows, stats },
    { headers: { "Cache-Control": "no-store" } },
  );
}
