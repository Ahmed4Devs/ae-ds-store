import { prisma } from "@/lib/db";
import { AeApiError, getOrderDetail, getTracking } from "@/lib/aliexpress";
import { cancelOrder } from "@/lib/order-cancel";
import { dictionaries, DEFAULT_LOCALE } from "@/lib/i18n/shared";
import type { OrderStatus } from "@/lib/generated/prisma/client";

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

const SOURCED_AE_STATUSES = new Set([
  "PLACE_ORDER_SUCCESS",
  "PLACE_ORDER_PENDING",
  "WAIT_BUYER_PAY",
  "WAIT_SELLER_SEND_GOODS",
  "WAIT_SELLER_EXAMINE_MONEY",
  "RISK_CONTROL",
  "RISK_CONTROL_HOLD",
]);

export type MappedAeStatus =
  | "SOURCED"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED"
  | "TRANSITIONING"
  | "UNKNOWN";

/** تعيين حالة AliExpress إلى حالة متجرنا. */
export function mapAeStatus(
  aeStatus: string | null,
  logisticsStatus: string | null,
): MappedAeStatus {
  // الصفوف الجديدة لم تُستقصَ بعد؛ نعاملها كمرحلة التوريد الدنيا عند جمع
  // حالة الطلب المقسّم، لا كحالة مزوّد مجهولة تستوجب إنذارًا.
  if (!aeStatus) return "SOURCED";

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
    if (logisticsStatus === "BUYER_ACCEPT_GOODS") return "DELIVERED";
    // مغادرة الشحنة لا تثبت استلام العميل. قد تُغلق FINISH بعد نزاع أو
    // استرداد وهي في الطريق، لذلك لا نعلن DELIVERED بلا دليل قبول صريح.
    if (logisticsStatus && SHIPPED_LOGISTICS.has(logisticsStatus)) {
      return "UNKNOWN";
    }
    return "CANCELLED";
  }

  // حالة مالية/إلغائية صريحة تتغلب على آخر إشارة لوجستية محفوظة؛ فقد تكون
  // الشحنة تحركت ثم بدأ نزاع أو استرداد، فلا نعلن تقدّمًا نهائيًا.
  if (aeStatus === "IN_CANCEL" || aeStatus === "FUND_PROCESSING") {
    return "TRANSITIONING";
  }

  const knownProgressStatus =
    aeStatus === "WAIT_BUYER_ACCEPT_GOODS" ||
    aeStatus === "BUYER_ACCEPT_GOODS" ||
    SOURCED_AE_STATUSES.has(aeStatus);
  if (!knownProgressStatus) return "UNKNOWN";

  if (
    aeStatus === "BUYER_ACCEPT_GOODS" ||
    logisticsStatus === "BUYER_ACCEPT_GOODS"
  ) {
    return "DELIVERED";
  }
  if (aeStatus === "WAIT_BUYER_ACCEPT_GOODS") return "SHIPPED";
  if (
    logisticsStatus === "SELLER_SEND_GOODS" ||
    logisticsStatus === "SELLER_SEND_PART_GOODS"
  ) {
    return "SHIPPED";
  }
  return "SOURCED";
}

type ParentProgress = "SOURCED" | "SHIPPED" | "DELIVERED";

const PROGRESS_RANK: Record<ParentProgress, number> = {
  SOURCED: 1,
  SHIPPED: 2,
  DELIVERED: 3,
};

function mayAdvanceOrder(current: string, next: ParentProgress): boolean {
  if (current === "CANCELLED" || current === "DELIVERED") return false;
  if (current === "SOURCED" || current === "SHIPPED") {
    return PROGRESS_RANK[next] > PROGRESS_RANK[current];
  }
  return ["PENDING_PAYMENT", "PAID", "SOURCING", "SOURCING_FAILED"].includes(
    current,
  );
}

export interface AeChildSyncState {
  aeOrderStatus: string | null;
  aeLogisticsStatus: string | null;
}

export type ParentSyncDecision =
  | { action: "ADVANCE"; status: ParentProgress }
  | { action: "CANCEL" }
  | { action: "REVIEW" }
  | { action: "HOLD" };

/**
 * يجمع حالات أطفال split order إلى قرار واحد محافظ للأب.
 *
 * هذه دالة نقية عمدًا: السياسة المالية/اللوجستية الحساسة قابلة لاختبار
 * جميع تراكيبها دون الحاجة إلى تزوير ردود المزوّد أو لمس قاعدة البيانات.
 */
export function deriveParentSyncDecision(input: {
  currentStatus: OrderStatus;
  needsManualReview: boolean;
  children: readonly AeChildSyncState[];
}): ParentSyncDecision {
  if (input.children.length === 0) return { action: "REVIEW" };
  if (input.currentStatus === "CANCELLED" || input.needsManualReview) {
    return { action: "HOLD" };
  }

  const states = input.children.map((child) =>
    mapAeStatus(child.aeOrderStatus, child.aeLogisticsStatus),
  );

  // أي قيمة جديدة، أو إلغاء/استرداد لا يزال قيد التنفيذ، تحتاج مطابقة
  // بشرية. تخمين حالة نهائية هنا قد يوحي بتسليم أو استرداد لم يحدث.
  if (states.includes("UNKNOWN") || states.includes("TRANSITIONING")) {
    return { action: "REVIEW" };
  }

  const cancelledChildren = states.filter(
    (state) => state === "CANCELLED",
  ).length;
  if (cancelledChildren > 0) {
    if (input.currentStatus === "DELIVERED") return { action: "REVIEW" };
    return cancelledChildren === states.length
      ? { action: "CANCEL" }
      : { action: "REVIEW" };
  }

  const progress: ParentProgress = states.every(
    (state) => state === "DELIVERED",
  )
    ? "DELIVERED"
    : states.some(
          (state) => state === "SHIPPED" || state === "DELIVERED",
        )
      ? "SHIPPED"
      : "SOURCED";

  // الدفع المحلي هو صاحب الحقيقة قبل التوريد؛ كما لا نسمح بتراجع حالة
  // لوجستية ثبتت سابقًا بسبب طفل لم يُستقصَ بعد أو رد قديم من المزوّد.
  if (
    input.currentStatus === "PENDING_PAYMENT" ||
    !mayAdvanceOrder(input.currentStatus, progress)
  ) {
    return { action: "HOLD" };
  }

  return { action: "ADVANCE", status: progress };
}

export interface SyncResult {
  polled: number;
  updated: number;
  errors: Array<{ aeOrderId: string; code: string }>;
}

/** يزامن طلبية واحدة من طلبيات AliExpress. */
export async function syncAeOrder(aeOrderRowId: string): Promise<boolean> {
  // حجز ذري قبل أي اتصال خارجي. لو وصلت صفحة العميل والـ cron معًا، يفوز
  // واحد فقط؛ البقية ترى lastPolledAt حديثًا ولا تضرب حصة AliExpress.
  const cutoff = new Date(Date.now() - MIN_POLL_INTERVAL_MS);
  const claimedAt = new Date();
  const claimed = await prisma.aeOrder.updateMany({
    where: {
      id: aeOrderRowId,
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }],
      order: { status: { not: "CANCELLED" } },
    },
    data: { lastPolledAt: claimedAt },
  });
  if (claimed.count === 0) return false;

  const row = await prisma.aeOrder.findUnique({
    where: { id: aeOrderRowId },
    include: {
      order: {
        select: { id: true, status: true, needsManualReview: true },
      },
    },
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
    let shouldCancel = false;
    let cancelForExpiredPayWindow = false;
    let becameShipped = false;

    const aggregateChanged = await prisma.$transaction(async (tx) => {
      // استقصاء طفلين قد ينتهي في اللحظة نفسها؛ قفل الأب يجعل الجمع يرى
      // لقطة متسقة ويمنع آخر طفل من طمس نتيجة الأول.
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT "id"::text AS "locked"
        FROM "Order"
        WHERE "id" = ${row.order.id}
        FOR UPDATE
      `;

      const current = await tx.order.findUnique({
        where: { id: row.order.id },
        select: { status: true, needsManualReview: true },
      });
      if (!current || current.status === "CANCELLED") return false;

      await tx.aeOrder.update({
        where: { id: row.id },
        data: {
          aeOrderStatus: detail.orderStatus,
          aeLogisticsStatus: detail.logisticsStatus,
          payTimeoutSecond: detail.payTimeoutSecond,
          amountBreakdown: detail.amountBreakdown as object,
          lastPolledAt: claimedAt,
        },
      });

      const children = await tx.aeOrder.findMany({
        where: { orderId: row.order.id },
        select: { aeOrderStatus: true, aeLogisticsStatus: true },
      });

      const decision = deriveParentSyncDecision({
        currentStatus: current.status,
        needsManualReview: current.needsManualReview,
        children,
      });

      if (decision.action === "REVIEW") {
        await tx.order.update({
          where: { id: row.order.id },
          data: {
            needsManualReview: true,
            manualReviewCode: "SUPPLIER_STATE_REVIEW",
            manualReviewNote:
              "حالات أجزاء طلبية المورد متعارضة أو تتضمن إلغاءً/استردادًا.",
            manualReviewOpenedAt: new Date(),
            manualReviewResolvedAt: null,
          },
        });
        return true;
      }

      if (decision.action === "CANCEL") {
        shouldCancel = true;
        return true;
      }

      // pay_timeout_second يخص الطفل. لا نلغي الأب إلا عندما تغلق النافذة
      // محليًا وهو ما يزال أصلًا PENDING_PAYMENT.
      cancelForExpiredPayWindow =
        current.status === "PENDING_PAYMENT" &&
        detail.payTimeoutSecond != null &&
        detail.payTimeoutSecond <= 0;
      if (cancelForExpiredPayWindow) {
        shouldCancel = true;
        return true;
      }

      if (decision.action === "HOLD") return true;

      await tx.order.update({
        where: { id: row.order.id },
        data: { status: decision.status },
      });
      becameShipped = decision.status === "SHIPPED";
      return true;
    });

    changed ||= aggregateChanged;

    if (shouldCancel) {
      // المرور من نقطة الإلغاء الوحيدة يضمن إبطال النيّات. الطلب المدفوع
      // لن يُلغى كذبًا بلا refund؛ cancelOrder يرفعه للمراجعة بدل ذلك.
      const cancelled = await cancelOrder(row.order.id, {
        actor: "system",
        reason: cancelForExpiredPayWindow
          ? dictionaries[DEFAULT_LOCALE].admin.autoCancelled
          : `AliExpress: ${detail.orderStatus ?? "CANCELLED"}`,
      });
      changed ||= cancelled.ok;
    }

    if (becameShipped) {
      // لا تعتمد رسالة الشحن على الطلب HTTP الحالي؛ القالب يبتلع فشل
      // النقل حتى لا تتراجع مزامنة صحيحة بسبب عطل البريد.
      const { sendOrderShippedMail } = await import("@/lib/mail");
      await sendOrderShippedMail(row.order.id);
    }
  } catch (e) {
    if (!(e instanceof AeApiError)) throw e;
    // lastPolledAt حُجزت قبل الاتصال؛ تُعاد المحاولة بعد الفاصل المحدد.
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
  // لا نسمح لقيمة مستدعاة بالخطأ أن تحوّل cron إلى مسح غير محدود للقاعدة
  // وحصة المزوّد. الصفر يبقى طلبًا مشروعًا لعدم تنفيذ أي استقصاء.
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(100, Math.max(0, Math.trunc(limit)))
    : 25;

  const rows = await prisma.aeOrder.findMany({
    where: {
      // PENDING_PAYMENT ضمن القائمة رغم أنها ليست «نشطة» بالمعنى المعتاد:
      // طلبية لها صفّ aeOrder وما زالت بلا دفع هي بالضبط الحالة التي تنتهي
      // مهلة دفعها لدى المنصة، ولن يلاحظها أحد إن لم تُستقصَ.
      order: { status: { in: ["SOURCED", "SHIPPED", "PAID", "PENDING_PAYMENT"] } },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }],
    },
    orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }],
    take: boundedLimit,
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
