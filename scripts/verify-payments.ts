import "dotenv/config";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { searchProducts, getProduct, getShippingOptions } from "@/lib/aliexpress";
import { createLocalOrder, markOrderPaid, sourceOrderFromAliExpress } from "@/lib/orders";
import { cancelOrder, canCancel } from "@/lib/order-cancel";
import {
  activeProvider,
  confirmManualPayment,
  createPaymentIntent,
  expireStaleIntents,
  getLatestIntent,
  settleIntent,
} from "@/lib/payments";
import { shippingAddressSchema } from "@/lib/ksa";
import type { Cart } from "@/lib/cart";

/**
 * تحقّق من طبقة الدفع وإلغاء الطلبيات.
 * يُشغَّل بـ: npm run verify:payments
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

const ADDRESS = shippingAddressSchema.parse({
  fullName: "عبدالله الأحمد",
  phone: "0512345678",
  province: "الرياض",
  city: "الرياض",
  addressLine1: "طريق الملك فهد، حي العليا",
  addressLine2: "",
  postalCode: "12211",
  nationalAddress: "RRDA2929",
  country: "SA",
});

/** يبني طلبية تجريبية من بيانات حيّة (وهمية في وضع المحاكاة). */
async function makeOrder(): Promise<{ orderId: string; orderNumber: string }> {
  const search = await searchProducts({ pageSize: 1 });
  const p = search.items[0];
  const detail = await getProduct(p.aeProductId);
  const shipping = await getShippingOptions({
    aeProductId: p.aeProductId,
    quantity: 1,
  });

  const cart: Cart = [
    {
      aeProductId: p.aeProductId,
      skuAttr: detail.skus[0].skuAttr,
      quantity: 1,
      logisticsServiceName: shipping[0].code,
    },
  ];

  return createLocalOrder({ cart, address: ADDRESS });
}

async function cleanup(orderId: string): Promise<void> {
  await prisma.aeApiLog.deleteMany({ where: { orderId } });
  await prisma.paymentIntent.deleteMany({ where: { orderId } });
  await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
}

async function main() {
  console.log("\n=== تحقّق طبقة الدفع والإلغاء ===");

  // حارس سلامة: هذا السكربت ينشئ طلبيات عبر مسار الشراء الحقيقي ثم يحذفها.
  // في وضع live كان يشتري من AliExpress فعلًا (وبمزوّد غير يدوي قد يخصم مالًا)
  // ثم يمحو السجلّ المحلي الوحيد. لا يُشغَّل إلا في المحاكاة والدفع اليدوي.
  const cfg = env();
  if (cfg.AE_MODE !== "mock" || cfg.PAYMENT_PROVIDER !== "manual") {
    console.error(
      `
✗ رُفض التشغيل: يتطلّب AE_MODE=mock و PAYMENT_PROVIDER=manual ` +
        `(الحالي AE_MODE=${cfg.AE_MODE} PAYMENT_PROVIDER=${cfg.PAYMENT_PROVIDER}).`,
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  section("المخطّط المستهدف في قاعدة البيانات");
  // PaymentIntent يخصّ مشروعنا وحده — نجاح الاستعلام يثبت إصابة المخطّط
  // المضبوط في ?schema= لا public، وهو تعارض صامت يفسد بيانات مشروع آخر.
  let schemaOk = true;
  try {
    await prisma.paymentIntent.count();
  } catch {
    schemaOk = false;
  }
  check("Prisma يستعلم في المخطّط الصحيح لا في public", schemaOk);

  section("المزوّد المضبوط");
  const provider = activeProvider();
  check("المزوّد معروف", ["manual", "moyasar", "tap"].includes(provider));
  console.log(`     المزوّد: ${provider}`);

  // ================================================================
  section("إتمام الشراء لا يدفع ولا يشتري");
  const a = await makeOrder();
  const afterCreate = await prisma.order.findUnique({
    where: { id: a.orderId },
    select: { status: true, aeOrders: { select: { id: true } } },
  });
  check(
    "الطلبية تبدأ بانتظار الدفع",
    afterCreate?.status === "PENDING_PAYMENT",
    afterCreate?.status,
  );
  check("لم تُشترَ من المورّد بعد", afterCreate?.aeOrders.length === 0);

  section("بوابة الحالة تمنع الشراء بلا دفع");
  // ⚠️ الفحص الأهم في هذا الملف: قبل بوابة الحالة كان هذا الاستدعاء
  // يشتري طلبية غير مدفوعة بمال حقيقي.
  const unpaid = await sourceOrderFromAliExpress(a.orderId);
  check(
    "رُفض توريد طلبية غير مدفوعة",
    !unpaid.ok && unpaid.errorCode === "ORDER_NOT_PAID",
    unpaid.ok ? "نجح التوريد!" : unpaid.errorCode,
  );
  const stillEmpty = await prisma.aeOrder.count({ where: { orderId: a.orderId } });
  check("لم تُنشأ أي طلبية لدى المنصة", stillEmpty === 0);

  section("نيّة الدفع");
  const intent = await createPaymentIntent(a.orderId);
  check("أُنشئت نيّة دفع", Boolean(intent.intentId));
  check("لها مرجع فريد لدى المزوّد", Boolean(intent.providerRef));
  const orderTotal = await prisma.order.findUnique({
    where: { id: a.orderId },
    select: { totalSar: true },
  });
  check(
    "المبلغ مأخوذ من الطلبية لا معادًا حسابه",
    Math.abs(intent.amountSar - Number(orderTotal?.totalSar ?? 0)) < 0.001,
  );

  const again = await createPaymentIntent(a.orderId);
  check(
    "طلب نيّة ثانية يعيد النيّة المفتوحة نفسها",
    again.intentId === intent.intentId,
  );

  section("التسوية خاملة (لا شراء مزدوج)");
  const first = await settleIntent(intent.providerRef, { status: "PAID" });
  check("طُبِّقت التسوية الأولى", first.applied);

  const afterFirst = await prisma.order.findUnique({
    where: { id: a.orderId },
    select: { status: true, aeOrders: { select: { aeOrderId: true } } },
  });
  check("أصبحت الطلبية مورَّدة", afterFirst?.status === "SOURCED", afterFirst?.status);
  const aeCount = afterFirst?.aeOrders.length ?? 0;
  check("أُنشئت طلبيات لدى المنصة", aeCount > 0);

  // ⚠️ جوهر الخمول: الإشعار المكرّر لا يشتري مرة ثانية
  const second = await settleIntent(intent.providerRef, { status: "PAID" });
  check("رُفضت التسوية المكرّرة", !second.applied);
  const aeCountAfter = await prisma.aeOrder.count({ where: { orderId: a.orderId } });
  check(
    "عدد طلبيات المنصة لم يتغيّر بعد الإشعار المكرّر",
    aeCountAfter === aeCount,
    `${aeCount} ← ${aeCountAfter}`,
  );

  await cleanup(a.orderId);

  // ================================================================
  section("الدفع المتأخّر لا يُحيي طلبية ملغاة");
  const b = await makeOrder();
  const bIntent = await createPaymentIntent(b.orderId);
  const cancelledB = await cancelOrder(b.orderId, {
    actor: "customer",
    reason: "فحص آلي",
  });
  check("أُلغيت الطلبية", cancelledB.ok);

  const bAfterCancel = await prisma.order.findUnique({
    where: { id: b.orderId },
    select: { status: true, cancelledAt: true, cancelReason: true },
  });
  check("الحالة CANCELLED", bAfterCancel?.status === "CANCELLED");
  check("سُجّل وقت الإلغاء", bAfterCancel?.cancelledAt != null);
  check("سُجّل سبب الإلغاء مع الفاعل", Boolean(bAfterCancel?.cancelReason));

  const bIntentAfter = await getLatestIntent(b.orderId);
  check(
    "أُبطلت نيّة الدفع مع الإلغاء",
    bIntentAfter?.status !== "REQUIRES_ACTION" && bIntentAfter?.status !== "PENDING",
    bIntentAfter?.status,
  );

  // إشعار متأخّر يصل بعد الإلغاء: يجب ألا يعيد الطلبية إلى PAID ولا يشتري
  await settleIntent(bIntent.providerRef, { status: "PAID" });
  const bFinal = await prisma.order.findUnique({
    where: { id: b.orderId },
    select: { status: true, aeOrders: { select: { id: true } } },
  });
  check(
    "الطلبية بقيت ملغاة رغم إشعار الدفع المتأخّر",
    bFinal?.status === "CANCELLED",
    bFinal?.status,
  );
  check("لم تُشترَ الطلبية الملغاة", bFinal?.aeOrders.length === 0);

  await cleanup(b.orderId);

  // ================================================================
  section("حدود الإلغاء");
  check("بانتظار الدفع قابلة للإلغاء", canCancel("PENDING_PAYMENT"));
  check("المدفوعة قابلة للإلغاء", canCancel("PAID"));
  check("المورَّدة غير قابلة للإلغاء", !canCancel("SOURCED"));
  check("المشحونة غير قابلة للإلغاء", !canCancel("SHIPPED"));
  check("المسلَّمة غير قابلة للإلغاء", !canCancel("DELIVERED"));

  const c = await makeOrder();
  await markOrderPaid(c.orderId);
  await sourceOrderFromAliExpress(c.orderId);
  const cCancel = await cancelOrder(c.orderId, { actor: "customer" });
  check(
    "رُفض إلغاء طلبية قائمة لدى المنصة",
    !cCancel.ok && cCancel.reason === "NOT_CANCELLABLE",
  );
  await cleanup(c.orderId);

  section("طلبية تحتاج مراجعة يدوية لا تُلغى ذاتيًا");
  // نحاكي أثر REPEATED_ORDER_ERROR: SOURCING_FAILED بلا صفوف AeOrder لكن
  // بعلَم المراجعة اليدوية. الحالة تبدو قابلة للإلغاء لكن العلَم يمنعه.
  const h = await makeOrder();
  await prisma.order.update({
    where: { id: h.orderId },
    data: { status: "SOURCING_FAILED", needsManualReview: true },
  });
  const hCancel = await cancelOrder(h.orderId, { actor: "customer" });
  check(
    "رُفض إلغاء طلبية مُعلَّمة للمراجعة اليدوية",
    !hCancel.ok && hCancel.reason === "NOT_CANCELLABLE",
  );
  await cleanup(h.orderId);

  // ================================================================
  section("تحديد الدفع كتابة شرطية");
  const d = await makeOrder();
  const firstPaid = await markOrderPaid(d.orderId);
  check("طُبِّق التحديد الأول", firstPaid);
  const secondPaid = await markOrderPaid(d.orderId);
  check("لم يُطبَّق التحديد الثاني (الحالة لم تعد بانتظار الدفع)", !secondPaid);
  await cleanup(d.orderId);

  // ================================================================
  section("انتهاء مهلة النيّات المعلّقة");
  const e = await makeOrder();
  const eIntent = await createPaymentIntent(e.orderId);
  await prisma.paymentIntent.update({
    where: { id: eIntent.intentId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expiredCount = await expireStaleIntents();
  check("أُنهيت مهلة النيّة المنتهية", expiredCount >= 1);
  const eAfter = await getLatestIntent(e.orderId);
  check("صارت حالتها EXPIRED", eAfter?.status === "EXPIRED", eAfter?.status);

  section("التأكيد اليدوي");
  if (provider === "manual") {
    const fresh = await createPaymentIntent(e.orderId);
    const confirmed = await confirmManualPayment(fresh.intentId);
    check("نجح التأكيد اليدوي", confirmed.ok, confirmed.message);
    const twice = await confirmManualPayment(fresh.intentId);
    check("رُفض التأكيد اليدوي المكرّر", !twice.ok);
  } else {
    console.log("     تخطٍّ — التأكيد اليدوي متاح للمزوّد manual وحده");
  }

  await cleanup(e.orderId);

  // ================================================================
  section("التحقق من المبلغ يمنع تسوية ناقصة");
  const f = await makeOrder();
  const fIntent = await createPaymentIntent(f.orderId);
  const fOrder = await prisma.order.findUnique({
    where: { id: f.orderId },
    select: { totalSar: true },
  });
  // إشعار بمبلغ أصغر بكثير من المستحق: يجب أن يُرفض لا أن يُسوّي الطلبية
  const shortPay = await settleIntent(fIntent.providerRef, {
    status: "PAID",
    amountSar: Number(fOrder?.totalSar ?? 0) - 100,
  });
  check("رُفضت تسوية بمبلغ أقل من المستحق", !shortPay.applied);
  const fAfter = await prisma.order.findUnique({
    where: { id: f.orderId },
    select: { status: true, aeOrders: { select: { id: true } } },
  });
  check("لم تُشترَ الطلبية بمبلغ ناقص", fAfter?.aeOrders.length === 0);
  check("عُلّمت النيّة FAILED بعدم تطابق المبلغ",
    (await getLatestIntent(f.orderId))?.status === "FAILED");
  await cleanup(f.orderId);

  // ================================================================
  section("الاسترداد يتجاوز مزلاج PAID");
  const g = await makeOrder();
  const gIntent = await createPaymentIntent(g.orderId);
  const gTotal = await prisma.order.findUnique({
    where: { id: g.orderId },
    select: { totalSar: true },
  });
  await settleIntent(gIntent.providerRef, {
    status: "PAID",
    amountSar: Number(gTotal?.totalSar ?? 0),
  });
  // الاسترداد بعد الدفع: المزلاج العام يرفض ما بعد PAID، لكن REFUNDED استثناء
  const refund = await settleIntent(gIntent.providerRef, { status: "REFUNDED" });
  check("طُبِّق الاسترداد رغم أن النيّة كانت PAID", refund.applied);
  check("صارت حالة النيّة REFUNDED",
    (await getLatestIntent(g.orderId))?.status === "REFUNDED");
  await cleanup(g.orderId);

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
