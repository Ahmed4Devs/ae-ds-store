import "dotenv/config";
import { randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { searchProducts, getProduct, getShippingOptions } from "@/lib/aliexpress";
import {
  createLocalOrder,
  deriveCheckoutSecurity,
  sourceOrderFromAliExpress,
  markOrderPaid,
} from "@/lib/orders";
import {
  deriveParentSyncDecision,
  mapAeStatus,
  syncAeOrder,
  syncOrderIfStale,
} from "@/lib/order-sync";
import { shippingAddressSchema } from "@/lib/ksa";
import { formatSar } from "@/lib/pricing";
import type { Cart } from "@/lib/cart";

/**
 * تحقّق من دورة حياة الطلبية كاملة مقابل قاعدة البيانات الحقيقية.
 * يُشغَّل بـ: npm run verify:orders
 */

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(t: string) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);
}

async function main() {
  const verificationStartedAt = new Date();
  console.log("\n=== تحقّق دورة حياة الطلبية ===");

  // حارس سلامة: يُنشئ هذا السكربت طلبيات عبر مسار الشراء الحقيقي ثم يحذفها.
  // في وضع live كان يشتري من AliExpress فعلًا ثم يمحو سجلّها المحلي.
  if (env().AE_MODE !== "mock") {
    console.error(`
✗ رُفض التشغيل: يتطلّب AE_MODE=mock (الحالي ${env().AE_MODE}).`);
    await prisma.$disconnect();
    process.exit(1);
  }

  section("المخطّط المستهدف في قاعدة البيانات");
  // AeApiLog يخص مشروعنا وحده. نجاح الاستعلام عنه يثبت أن مُهيّئ التعريف
  // يصيب المخطّط المضبوط في ?schema= لا المخطّط الافتراضي public — وهو
  // تعارض صامت يفسد بيانات مشروع آخر يشارك القاعدة بأسماء جداول مشابهة.
  let schemaOk = true;
  try {
    await prisma.aeApiLog.count();
  } catch {
    schemaOk = false;
  }
  check("Prisma يستعلم في المخطّط الصحيح لا في public", schemaOk);

  section("سياسة تجميع الطلبية المقسّمة");
  const child = (
    aeOrderStatus: string | null,
    aeLogisticsStatus: string | null = null,
  ) => ({ aeOrderStatus, aeLogisticsStatus });
  const decide = (
    currentStatus:
      | "PENDING_PAYMENT"
      | "PAID"
      | "SOURCING"
      | "SOURCED"
      | "SOURCING_FAILED"
      | "SHIPPED"
      | "DELIVERED"
      | "CANCELLED",
    children: ReturnType<typeof child>[],
    needsManualReview = false,
  ) =>
    deriveParentSyncDecision({
      currentStatus,
      needsManualReview,
      children,
    });

  check(
    "FINISH مع قبول المشتري وحده يثبت التسليم",
    mapAeStatus("FINISH", "BUYER_ACCEPT_GOODS") === "DELIVERED",
  );
  check(
    "FINISH مع مجرد إرسال الشحنة لا يُعلن تسليمًا كاذبًا",
    mapAeStatus("FINISH", "SELLER_SEND_GOODS") === "UNKNOWN",
  );
  check(
    "طفل مسلّم وآخر قيد التجهيز يجعلان الأب SHIPPED فقط",
    JSON.stringify(
      decide("SOURCED", [
        child("BUYER_ACCEPT_GOODS"),
        child("PLACE_ORDER_SUCCESS"),
      ]),
    ) === JSON.stringify({ action: "ADVANCE", status: "SHIPPED" }),
  );
  check(
    "لا يصبح الأب DELIVERED حتى تُسلَّم كل الأجزاء",
    JSON.stringify(
      decide("SHIPPED", [
        child("BUYER_ACCEPT_GOODS"),
        child("BUYER_ACCEPT_GOODS"),
      ]),
    ) === JSON.stringify({ action: "ADVANCE", status: "DELIVERED" }),
  );
  check(
    "لا تتراجع SHIPPED إلى SOURCED بسبب رد قديم",
    decide("SHIPPED", [
      child("PLACE_ORDER_SUCCESS"),
      child(null),
    ]).action === "HOLD",
  );
  check(
    "إلغاء جزء واحد يرفع مراجعة ولا يلغي الأب كله",
    decide("SOURCED", [
      child("FINISH", "NO_LOGISTICS"),
      child("PLACE_ORDER_SUCCESS"),
    ]).action === "REVIEW",
  );
  check(
    "إلغاء جميع الأجزاء يمر من مسار الإلغاء المركزي",
    decide("SOURCED", [
      child("FINISH", "NO_LOGISTICS"),
      child("FINISH", "NO_LOGISTICS"),
    ]).action === "CANCEL",
  );
  check(
    "الإلغاء أو الاسترداد الانتقالي يرفع مراجعة",
    decide("SOURCED", [
      child("FUND_PROCESSING", "BUYER_ACCEPT_GOODS"),
      child("BUYER_ACCEPT_GOODS"),
    ]).action === "REVIEW",
  );
  check(
    "حالة مزوّد جديدة تفشل مغلقًا ولو حملت إشارة تسليم",
    decide("SOURCED", [
      child("UNRECOGNIZED_PROVIDER_STATE", "BUYER_ACCEPT_GOODS"),
    ]).action === "REVIEW",
  );
  check(
    "قبول المشتري لوجستيًا يثبت التسليم للحالة المعروفة",
    mapAeStatus("WAIT_BUYER_ACCEPT_GOODS", "BUYER_ACCEPT_GOODS") ===
      "DELIVERED",
  );
  check(
    "PENDING_PAYMENT لا تُرقّى من كلام المزوّد",
    decide("PENDING_PAYMENT", [child("WAIT_BUYER_ACCEPT_GOODS")]).action ===
      "HOLD",
  );

  section("تجهيز سلة من بيانات حيّة");
  const search = await searchProducts({ pageSize: 2 });
  const [p1, p2] = search.items;
  const [d1, d2] = await Promise.all([getProduct(p1.aeProductId), getProduct(p2.aeProductId)]);
  const [s1, s2] = await Promise.all([
    getShippingOptions({ aeProductId: p1.aeProductId, quantity: 1 }),
    getShippingOptions({ aeProductId: p2.aeProductId, quantity: 2 }),
  ]);

  const cart: Cart = [
    {
      aeProductId: p1.aeProductId,
      skuAttr: d1.skus[0].skuAttr,
      quantity: 1,
      logisticsServiceName: s1.find((o) => o.hasTracking)!.code,
    },
    {
      aeProductId: p2.aeProductId,
      skuAttr: d2.skus[0].skuAttr,
      quantity: 2,
      logisticsServiceName: s2.find((o) => o.hasTracking)!.code,
    },
  ];
  check("سلة بسطرين جاهزة", cart.length === 2);

  section("التحقق من العنوان السعودي");
  const address = shippingAddressSchema.parse({
    fullName: "أحمد بن محمد التجريبي",
    phone: "0512345678",
    province: "الرياض",
    city: "الرياض",
    addressLine1: "طريق الملك فهد، حي العليا، مبنى 7",
    postalCode: "12211",
    nationalAddress: "rrda2929",
  });
  check("العنوان صالح ومطبّع", address.phone === "512345678" && address.nationalAddress === "RRDA2929");

  section("تثبيت الطلبية محليًا");
  const checkoutSecurity = deriveCheckoutSecurity(
    randomBytes(32).toString("base64url"),
  );
  // الاستدعاءان المتوازيان يحاكيان نقرة مزدوجة أو إعادة POST من وسيط؛
  // الفهرس الدائم يجب أن ينتج صفًا واحدًا لا مجرد حماية داخل العملية.
  const [created, replayed] = await Promise.all([
    createLocalOrder({ cart, address, ...checkoutSecurity }),
    createLocalOrder({ cart, address, ...checkoutSecurity }),
  ]);
  check(
    "كل SKU قابل للبيع يحمل سعرًا موجبًا",
    [...d1.skus, ...d2.skus].every(
      (sku) => Number.isFinite(sku.sourcePrice) && sku.sourcePrice > 0,
    ),
  );
  check(
    "عملات المنتج والشحن تطابق عملة المصدر",
    [d1.currency, d2.currency, ...s1.map((x) => x.currency), ...s2.map((x) => x.currency)]
      .every((currency) => currency === env().AE_SOURCE_CURRENCY),
  );
  check("أُنشئت الطلبية", Boolean(created.orderId), created.orderNumber);
  check(
    "checkout المتزامن يعيد الطلبية نفسها",
    replayed.orderId === created.orderId,
  );

  const stored = await prisma.order.findUnique({
    where: { id: created.orderId },
    include: { items: true },
  });
  check("لها outOrderId فريد (مفتاح منع التكرار)", Boolean(stored?.outOrderId));
  check(
    "قدرة طلب الضيف مخزنة كبصمة مع انتهاء صلاحية",
    Boolean(stored?.guestAccessHash && stored.guestAccessExpiresAt),
  );
  check("سعر الصرف مثبَّت على الطلبية", Number(stored?.fxRateUsed) > 0, String(stored?.fxRateUsed));
  check("عدد الأسطر صحيح", stored?.items.length === 2);
  check(
    "كل سطر يحمل skuAttr وlogisticsServiceName",
    stored!.items.every((i) => i.skuAttr && i.logisticsServiceName),
  );
  check("الحالة الابتدائية بانتظار الدفع", stored?.status === "PENDING_PAYMENT");
  console.log(
    `     الإجمالي: ${formatSar(Number(stored!.totalSar))} · التكلفة: $${stored!.costSubtotal} + $${stored!.costShipping} شحن`,
  );

  section("الدفع ثم التوريد من AliExpress");
  await prisma.paymentIntent.create({
    data: {
      orderId: created.orderId,
      provider: "manual",
      providerRef: `verify-paid-${created.orderId}`,
      status: "PAID",
      amountSar: stored!.totalSar,
      currency: "SAR",
      paidAt: new Date(),
    },
  });
  await markOrderPaid(created.orderId);
  const sourced = await sourceOrderFromAliExpress(created.orderId, { tryToPay: false });
  check("نجح التوريد", sourced.ok, sourced.ok ? "" : sourced.errorCode);

  if (sourced.ok) {
    check(
      "order_list مصفوفة — قد تنقسم على عدة بائعين",
      Array.isArray(sourced.aeOrderIds) && sourced.aeOrderIds.length >= 1,
      `عدد طلبيات AliExpress: ${sourced.aeOrderIds.length}`,
    );
    console.log(`     المعرّفات: ${sourced.aeOrderIds.join(", ")}`);
  }

  const afterSourcing = await prisma.order.findUnique({
    where: { id: created.orderId },
    include: { aeOrders: true },
  });
  check("الحالة أصبحت SOURCED", afterSourcing?.status === "SOURCED");
  check(
    "طلبيات AliExpress محفوظة بعلاقة واحد-إلى-متعدد",
    (afterSourcing?.aeOrders.length ?? 0) >= 1,
    `${afterSourcing?.aeOrders.length}`,
  );

  section("منع الشراء المزدوج");
  const second = await sourceOrderFromAliExpress(created.orderId, { tryToPay: false });
  check("إعادة الاستدعاء لا تُنشئ طلبية جديدة", second.ok);
  const recheck = await prisma.aeOrder.count({ where: { orderId: created.orderId } });
  check(
    "عدد طلبيات AliExpress لم يتغيّر",
    recheck === (afterSourcing?.aeOrders.length ?? 0),
    `${recheck}`,
  );

  section("تكامل تجميع split order");
  const splitChildren = afterSourcing?.aeOrders ?? [];
  check(
    "بيانات المحاكاة أنشأت طفلين لاختبار التجميع",
    splitChildren.length >= 2,
    `${splitChildren.length}`,
  );
  if (splitChildren.length >= 2) {
    const [firstChild, secondChild] = splitChildren;

    await prisma.order.update({
      where: { id: created.orderId },
      data: { status: "SOURCED", needsManualReview: false },
    });
    await prisma.aeOrder.updateMany({
      where: { orderId: created.orderId },
      data: {
        aeOrderStatus: "PLACE_ORDER_SUCCESS",
        aeLogisticsStatus: "NO_LOGISTICS",
        lastPolledAt: new Date(),
      },
    });
    await prisma.aeOrder.update({
      where: { id: firstChild.id },
      data: { lastPolledAt: null },
    });
    await prisma.aeOrder.update({
      where: { id: secondChild.id },
      data: {
        aeOrderStatus: "WAIT_BUYER_ACCEPT_GOODS",
        aeLogisticsStatus: "SELLER_SEND_GOODS",
      },
    });
    await syncAeOrder(firstChild.id);
    const mixedProgress = await prisma.order.findUnique({
      where: { id: created.orderId },
      select: { status: true },
    });
    check(
      "معاملة التجميع ترى كل الأطفال وترفع الأب إلى SHIPPED",
      mixedProgress?.status === "SHIPPED",
      mixedProgress?.status,
    );

    await prisma.order.update({
      where: { id: created.orderId },
      data: { status: "SOURCED", needsManualReview: false },
    });
    await prisma.aeOrder.updateMany({
      where: { orderId: created.orderId },
      data: {
        aeOrderStatus: "PLACE_ORDER_SUCCESS",
        aeLogisticsStatus: "NO_LOGISTICS",
        lastPolledAt: new Date(),
      },
    });
    await prisma.aeOrder.update({
      where: { id: firstChild.id },
      data: {
        aeOrderStatus: "FINISH",
        aeLogisticsStatus: "NO_LOGISTICS",
      },
    });
    await prisma.aeOrder.update({
      where: { id: secondChild.id },
      data: { lastPolledAt: null },
    });
    await syncAeOrder(secondChild.id);
    const partialCancellation = await prisma.order.findUnique({
      where: { id: created.orderId },
      select: { status: true, needsManualReview: true },
    });
    check(
      "إلغاء طفل واحد فعليًا يثبّت الأب ويرفع المراجعة",
      partialCancellation?.status === "SOURCED" &&
        partialCancellation.needsManualReview,
      `${partialCancellation?.status}/${partialCancellation?.needsManualReview}`,
    );
  }

  section("المزامنة والتتبع");
  await prisma.order.update({
    where: { id: created.orderId },
    data: { status: "SHIPPED", needsManualReview: false },
  });
  await prisma.aeOrder.updateMany({
    where: { orderId: created.orderId },
    data: {
      aeOrderStatus: null,
      aeLogisticsStatus: null,
      payTimeoutSecond: null,
      lastPolledAt: null,
    },
  });
  const syncApiNames = [
    "aliexpress.trade.ds.order.get",
    "aliexpress.ds.order.tracking.get",
  ];
  const splitAeIds = new Set(splitChildren.map((row) => row.aeOrderId));
  const isCurrentSplitLog = (requestSummary: unknown) => {
    const serialized = JSON.stringify(requestSummary) ?? "";
    return [...splitAeIds].some((id) => serialized.includes(id));
  };
  const syncLogsBefore = await prisma.aeApiLog.findMany({
    where: {
      apiName: { in: syncApiNames },
      createdAt: { gte: verificationStartedAt },
    },
    select: { id: true, requestSummary: true },
  });
  const relevantBefore = new Set(
    syncLogsBefore
      .filter((log) => isCurrentSplitLog(log.requestSummary))
      .map((log) => log.id),
  );
  await Promise.all(
    Array.from({ length: 5 }, () => syncOrderIfStale(created.orderId)),
  );
  const syncLogsAfter = await prisma.aeApiLog.findMany({
    where: {
      apiName: { in: syncApiNames },
      createdAt: { gte: verificationStartedAt },
    },
    select: { id: true, requestSummary: true },
  });
  const relevantSyncLogs = syncLogsAfter.filter((log) =>
    isCurrentSplitLog(log.requestSummary),
  );
  const syncCallDelta = relevantSyncLogs.filter(
    (log) => !relevantBefore.has(log.id),
  ).length;
  const synced = await prisma.aeOrder.findMany({
    where: { orderId: created.orderId },
    include: { packages: true },
  });
  check("تم استقصاء الحالة", synced.every((a) => a.lastPolledAt !== null));
  check(
    "خمسة استقصاءات متزامنة لم تضاعف اتصالات المورد",
    syncCallDelta === synced.length * 2,
    `${syncCallDelta} اتصالًا لـ ${synced.length} طلب مورد`,
  );
  const afterConcurrentSync = await prisma.order.findUnique({
    where: { id: created.orderId },
    select: { status: true },
  });
  check(
    "الردود الأقدم لا خفّضت الأب أثناء السباق",
    afterConcurrentSync?.status === "SHIPPED",
    afterConcurrentSync?.status,
  );
  check(
    "حالة AliExpress محفوظة",
    synced.some((a) => a.aeOrderStatus !== null),
    synced.map((a) => a.aeOrderStatus).join(", "),
  );
  check(
    "pay_timeout_second محفوظ (لمراقبة الإلغاء التلقائي)",
    synced.some((a) => a.payTimeoutSecond !== null),
    String(synced[0]?.payTimeoutSecond),
  );

  section("سجل استدعاءات الواجهات");
  const logs = await prisma.aeApiLog.findMany({
    where: { orderId: created.orderId },
  });
  check("استدعاء إنشاء الطلبية مسجَّل", logs.length > 0, `${logs.length} سجل`);
  const anyLog = await prisma.aeApiLog.findFirst({
    where: { apiName: "aliexpress.ds.order.create" },
    orderBy: { createdAt: "desc" },
  });
  const summary = JSON.stringify(anyLog?.requestSummary ?? {});
  check("الأسرار محجوبة في السجل", !summary.includes("app_secret"));

  section("تنظيف بيانات الاختبار");
  await prisma.aeApiLog.deleteMany({
    where: { id: { in: relevantSyncLogs.map((log) => log.id) } },
  });
  await prisma.aeApiLog.deleteMany({ where: { orderId: created.orderId } });
  await prisma.paymentIntent.deleteMany({ where: { orderId: created.orderId } });
  await prisma.order.delete({ where: { id: created.orderId } });
  const gone = await prisma.order.findUnique({ where: { id: created.orderId } });
  check("حُذفت الطلبية التجريبية", gone === null);

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  نجح: ${passed}   |   فشل: ${failed}`);
  console.log(`${"═".repeat(62)}\n`);

  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error("\n✗ فشل التحقق:", e);
  await prisma.$disconnect();
  process.exit(1);
});
