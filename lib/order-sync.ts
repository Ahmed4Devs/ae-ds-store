import { prisma } from "@/lib/db";
import { AeApiError, getOrderDetail, getTracking } from "@/lib/aliexpress";

/**
 * مزامنة حالة الطلبيات والتتبع.
 *
 * لا توفّر واجهات AliExpress إشعارات فورية (webhooks) لتغيّر حالة الطلبية،
 * فالاستقصاء الدوري هو الخيار الوحيد المتاح. لذلك يُستدعى هذا الملف
 * من مهمة مجدولة، ومن صفحة تفاصيل الطلبية عند فتحها إن مضى وقت كافٍ.
 */

/** أقل فاصل بين استقصاءين للطلبية الواحدة — يمنع استنزاف حصة الاستدعاءات. */
const MIN_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 دقائق

/** تعيين حالة AliExpress إلى حالة متجرنا. */
function mapStatus(
  aeStatus: string | null,
  logisticsStatus: string | null,
): "SOURCED" | "SHIPPED" | "DELIVERED" | "CANCELLED" | null {
  if (!aeStatus) return null;
  if (aeStatus === "FINISH") return "DELIVERED";
  if (aeStatus === "WAIT_BUYER_ACCEPT_GOODS") return "SHIPPED";
  if (
    logisticsStatus === "SELLER_SEND_GOODS" ||
    logisticsStatus === "SELLER_SEND_PART_GOODS"
  ) {
    return "SHIPPED";
  }
  if (aeStatus === "BUYER_ACCEPT_GOODS") return "DELIVERED";
  if (aeStatus === "IN_CANCEL" || aeStatus === "FUND_PROCESSING") return null;
  return "SOURCED";
}

export interface SyncResult {
  polled: number;
  updated: number;
  errors: Array<{ aeOrderId: string; code: string }>;
}

/** يزامن طلبية واحدة من طلبيات AliExpress. */
export async function syncAeOrder(aeOrderRowId: string): Promise<boolean> {
  const row = await prisma.aeOrder.findUnique({
    where: { id: aeOrderRowId },
    include: { order: { select: { id: true, status: true } } },
  });
  if (!row) return false;

  let changed = false;

  // --- حالة الطلبية ---
  try {
    const detail = await getOrderDetail(row.aeOrderId);
    await prisma.aeOrder.update({
      where: { id: row.id },
      data: {
        aeOrderStatus: detail.orderStatus,
        aeLogisticsStatus: detail.logisticsStatus,
        payTimeoutSecond: detail.payTimeoutSecond,
        amountBreakdown: detail.amountBreakdown as object,
        lastPolledAt: new Date(),
      },
    });

    const mapped = mapStatus(detail.orderStatus, detail.logisticsStatus);
    if (mapped && mapped !== row.order.status) {
      await prisma.order.update({
        where: { id: row.order.id },
        data: { status: mapped },
      });
      changed = true;
    }
  } catch (e) {
    if (!(e instanceof AeApiError)) throw e;
    await prisma.aeOrder.update({
      where: { id: row.id },
      data: { lastPolledAt: new Date() },
    });
  }

  // --- التتبع ---
  try {
    const packages = await getTracking(row.aeOrderId);
    for (const pkg of packages) {
      await prisma.trackingPackage.upsert({
        where: {
          aeOrderId_mailNo: { aeOrderId: row.id, mailNo: pkg.mailNo },
        },
        create: {
          aeOrderId: row.id,
          mailNo: pkg.mailNo,
          carrierName: pkg.carrierName,
          cpName: pkg.cpName,
          cpWebsiteUrl: pkg.cpWebsiteUrl,
          etaAt: pkg.etaAt,
          nodes: pkg.nodes as unknown as object,
        },
        update: {
          carrierName: pkg.carrierName,
          cpName: pkg.cpName,
          cpWebsiteUrl: pkg.cpWebsiteUrl,
          etaAt: pkg.etaAt,
          nodes: pkg.nodes as unknown as object,
        },
      });
      changed = true;
    }
  } catch (e) {
    // غياب التتبع قبل الشحن حالة طبيعية موثّقة
    if (!(e instanceof AeApiError)) throw e;
  }

  return changed;
}

/** يزامن الطلبيات النشطة التي مضى على آخر استقصاء لها وقت كافٍ. */
export async function syncActiveOrders(limit = 25): Promise<SyncResult> {
  const cutoff = new Date(Date.now() - MIN_POLL_INTERVAL_MS);

  const rows = await prisma.aeOrder.findMany({
    where: {
      order: { status: { in: ["SOURCED", "SHIPPED", "PAID"] } },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }],
    },
    orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }],
    take: limit,
    select: { id: true, aeOrderId: true },
  });

  const result: SyncResult = { polled: 0, updated: 0, errors: [] };

  for (const row of rows) {
    result.polled++;
    try {
      if (await syncAeOrder(row.id)) result.updated++;
    } catch (e) {
      result.errors.push({
        aeOrderId: row.aeOrderId,
        code: e instanceof AeApiError ? e.code : "UNKNOWN",
      });
    }
  }

  return result;
}

/** يزامن طلبية متجر واحدة عند الطلب (تُستدعى من صفحة التفاصيل). */
export async function syncOrderIfStale(orderId: string): Promise<void> {
  const cutoff = new Date(Date.now() - MIN_POLL_INTERVAL_MS);
  const rows = await prisma.aeOrder.findMany({
    where: {
      orderId,
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }],
    },
    select: { id: true },
  });
  for (const r of rows) {
    try {
      await syncAeOrder(r.id);
    } catch {
      // لا نُسقط عرض الصفحة بسبب فشل المزامنة
    }
  }
}
