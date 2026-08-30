import "dotenv/config";
import { prisma } from "@/lib/db";
import { searchProducts, getProduct, getShippingOptions } from "@/lib/aliexpress";
import { createLocalOrder, sourceOrderFromAliExpress, markOrderPaid } from "@/lib/orders";
import { syncOrderIfStale } from "@/lib/order-sync";
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
  console.log("\n=== تحقّق دورة حياة الطلبية ===");

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
  const created = await createLocalOrder({ cart, address });
  check("أُنشئت الطلبية", Boolean(created.orderId), created.orderNumber);

  const stored = await prisma.order.findUnique({
    where: { id: created.orderId },
    include: { items: true },
  });
  check("لها outOrderId فريد (مفتاح منع التكرار)", Boolean(stored?.outOrderId));
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

  section("المزامنة والتتبع");
  await syncOrderIfStale(created.orderId);
  const synced = await prisma.aeOrder.findMany({
    where: { orderId: created.orderId },
    include: { packages: true },
  });
  check("تم استقصاء الحالة", synced.every((a) => a.lastPolledAt !== null));
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
  await prisma.aeApiLog.deleteMany({ where: { orderId: created.orderId } });
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
