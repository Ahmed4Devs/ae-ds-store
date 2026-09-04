import { prisma } from "@/lib/db";
import { AeApiError, getOrderDetail, getTracking } from "@/lib/aliexpress";
import { cancelOrder } from "@/lib/order-cancel";
import { dictionaries, DEFAULT_LOCALE } from "@/lib/i18n/shared";

/**
 * مزامنة حالة الطلبيات والتتبع.
 *
 * لا توفّر واجهات AliExpress إشعارات فورية (webhooks) لتغيّر حالة الطلبية،
 * فالاستقصاء الدوري هو الخيار الوحيد المتاح. لذلك يُستدعى هذا الملف
 * من مهمة مجدولة، ومن صفحة تفاصيل الطلبية عند فتحها إن مضى وقت كافٍ.
 */

/** أقل فاصل بين استقصاءين للطلبية الواحدة — يمنع استنزاف حصة الاستدعاءات. */
const MIN_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 دقائق

/** دلائل على أن الشحنة غادرت فعلًا — تُميّز الإغلاق بالتسليم من الإغلاق بالإلغاء. */
const SHIPPED_LOGISTICS = new Set([
  "SELLER_SEND_GOODS",
  "SELLER_SEND_PART_GOODS",
  "BUYER_ACCEPT_GOODS",
]);

/** تعيين حالة AliExpress إلى حالة متجرنا. */
function mapStatus(
  aeStatus: string | null,
  logisticsStatus: string | null,
): "SOURCED" | "SHIPPED" | "DELIVERED" | "CANCELLED" | null {
  if (!aeStatus) return null;

  /**
   * ⚠️ `FINISH` تعني «أُغلقت» لا «سُلّمت».
   *
   * تستعمل المنصة هذه الحالة لكل طلبية انتهت دورتها — بما فيها ما أُغلق
   * دون دفع أو أُلغي. فكان تعيينها إلى DELIVERED مباشرةً يسجّل الطلبية
   * **المُلغاة على أنها مُسلَّمة بنجاح**، وهي بالضبط الحالة التي وُضع
   * الإلغاء التلقائي ليلتقطها.
   *
   * التمييز بدليل الشحن: إن لم تغادر الشحنة قط فالإغلاق إلغاء لا تسليم.
   */
  if (aeStatus === "FINISH") {
    return logisticsStatus && SHIPPED_LOGISTICS.has(logisticsStatus)
      ? "DELIVERED"
      : "CANCELLED";
  }

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

  /**
   * الطلبية الملغاة لا تُزامَن.
   *
   * الفرع الافتراضي في `mapStatus` يعيد "SOURCED"، وشرط الكتابة هو مجرّد
   * اختلاف الحالة المحسوبة عن المخزّنة — فكان أوّل استقصاء بعد الإلغاء
   * **يُعيد الطلبية الملغاة إلى «قيد التجهيز»** بصمت. والأسوأ أن
   * `syncOrderIfStale` تعمل عند كل فتح لصفحة الطلب، فيكفي أن يفتح
   * العميل صفحته ليُلغى إلغاؤه.
   *
   * الإلغاء حالة نهائية عندنا: ما بعده لا يُقرأ من المنصة.
   */
  if (row.order.status === "CANCELLED") return false;

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

    // انتهت مهلة الدفع لدى المنصة ولم تُدفع لدينا أصلًا. الحقل
    // pay_timeout_second هو الثواني **المتبقية**، فالصفر فما دون يعني أن
    // النافذة أُغلقت: الطلبية لن تُشترى أبدًا وبقاؤها PENDING_PAYMENT
    // يخدع العميل ويترك نيّة دفعه مفتوحة إلى ما لا نهاية.
    const payWindowClosed =
      row.order.status === "PENDING_PAYMENT" &&
      detail.payTimeoutSecond != null &&
      detail.payTimeoutSecond <= 0;

    if (mapped === "CANCELLED" || payWindowClosed) {
      // لا نكتب CANCELLED هنا مباشرةً: المرور بـ cancelOrder هو ما يضمن
      // إبطال نيّات الدفع وإرسال بريد الإلغاء مهما كان مصدر الإلغاء.
      const cancelled = await cancelOrder(row.order.id, {
        actor: "system",
        reason: payWindowClosed
          ? // القاموس يُقرأ باللغة الافتراضية لا من الكوكيز: المزامنة تعمل
            // في مهمة مجدولة بلا سياق طلب.
            dictionaries[DEFAULT_LOCALE].admin.autoCancelled
          : `AliExpress: ${detail.orderStatus ?? "CANCELLED"}`,
      });
      if (cancelled.ok) changed = true;
    } else if (
      mapped &&
      mapped !== row.order.status &&
      // الطلبية غير المدفوعة لدينا لا تُرقّى بحالة المنصة: فرع mapStatus
      // الافتراضي يعيد "SOURCED"، فكانت طلبيةٌ في PENDING_PAYMENT تُرقّى إلى
      // «قيد التجهيز» فيُهزَم الإلغاء التلقائي عند انتهاء مهلة الدفع. مخارج
      // PENDING_PAYMENT الوحيدة: نجاح الدفع، أو الإلغاء التلقائي أعلاه.
      row.order.status !== "PENDING_PAYMENT"
    ) {
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
      // PENDING_PAYMENT ضمن القائمة رغم أنها ليست «نشطة» بالمعنى المعتاد:
      // طلبية لها صفّ aeOrder وما زالت بلا دفع هي بالضبط الحالة التي تنتهي
      // مهلة دفعها لدى المنصة، ولن يلاحظها أحد إن لم تُستقصَ.
      order: { status: { in: ["SOURCED", "SHIPPED", "PAID", "PENDING_PAYMENT"] } },
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
