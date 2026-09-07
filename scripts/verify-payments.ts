import "dotenv/config";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { consumeDatabaseRateLimit } from "@/lib/database-rate-limit";
import { searchProducts, getProduct, getShippingOptions } from "@/lib/aliexpress";
import { createLocalOrder, markOrderPaid, sourceOrderFromAliExpress } from "@/lib/orders";
import { cancelOrder, canCancel } from "@/lib/order-cancel";
import {
  activeProvider,
  confirmManualPayment,
  createPaymentIntent,
  expireStaleIntents,
  getLatestIntent,
  sanitizePaymentFailureCode,
  sanitizePaymentFailureMessage,
  settleIntent,
} from "@/lib/payments";
import { shippingAddressSchema } from "@/lib/ksa";
import type { Cart } from "@/lib/cart";
import {
  fetchPaymentProvider,
  readProviderJson,
} from "@/lib/payments/security";

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

/** يضيف سجل دفع موثّقًا قبل اختبار انتقال Order إلى PAID مباشرةً. */
async function attachPaidProof(orderId: string, label: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { totalSar: true },
  });
  await prisma.paymentIntent.create({
    data: {
      orderId,
      provider: "manual",
      providerRef: `verify-paid-${label}-${orderId}`,
      status: "PAID",
      amountSar: order.totalSar,
      currency: "SAR",
      paidAt: new Date(),
    },
  });
}

/** يبني إثباتًا ماليًا كاملًا كما تفعل webhook الحقيقية. */
async function settleManual(
  providerRef: string,
  status: "PAID" | "FAILED" | "EXPIRED" | "REFUNDED",
  amountOverride?: number,
) {
  const row = await prisma.paymentIntent.findUniqueOrThrow({
    where: { providerRef },
    select: { amountSar: true, currency: true },
  });
  return settleIntent(providerRef, {
    status,
    provider: "manual",
    amountSar: amountOverride ?? Number(row.amountSar),
    currency: row.currency,
    payload: { source: "security-verification" },
  });
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

  section("تعقيم بيانات فشل المزوّد");
  const safeCode = sanitizePaymentFailureCode("\r\nbad code<script>");
  const safeMessage = sanitizePaymentFailureMessage(
    "<img>\r\nprovider failure\u0000",
  );
  check(
    "رمز الفشل صار معرّفًا محدودًا بلا محارف تحكم",
    safeCode === "bad_code_script" && /^[A-Za-z0-9_.:-]{1,100}$/.test(safeCode),
    safeCode ?? "null",
  );
  check(
    "رسالة الفشل صارت نصًا محدودًا بلا HTML أو محارف تحكم",
    safeMessage === "img provider failure" &&
      !/[<>\u0000-\u001f\u007f]/u.test(safeMessage),
    safeMessage ?? "null",
  );
  const rejectedProviderRef = await settleIntent("bad\r\nreference", {
    status: "FAILED",
    provider: "manual",
    amountSar: 1,
    currency: "SAR",
  });
  check("رُفض مرجع مزوّد يحوي محارف تحكم", !rejectedProviderRef.applied);

  let ssrfRejected = false;
  try {
    await fetchPaymentProvider("https://example.invalid/steal", {
      headers: { Authorization: "Bearer must-not-leave" },
    });
  } catch {
    ssrfRejected = true;
  }
  check("عميل الدفع يرفض مضيفًا خارج قائمة المزوّدين", ssrfRejected);

  let wrongProviderTypeRejected = false;
  try {
    await readProviderJson(
      new Response("{}", { headers: { "content-type": "text/html" } }),
    );
  } catch {
    wrongProviderTypeRejected = true;
  }
  check("عميل الدفع يرفض استجابة ليست JSON", wrongProviderTypeRejected);

  section("الخنق الموزّع قبل مصالحة بوابة الدفع");
  const limiterKey = `verify:payment-rate:${randomUUID()}`;
  try {
    const decisions = await Promise.all(
      Array.from({ length: 8 }, () =>
        consumeDatabaseRateLimit(limiterKey, 3, 60_000),
      ),
    );
    check(
      "الحد الذري لا يسمح بأكثر من ثلاث محاولات متزامنة",
      decisions.filter((decision) => decision.ok).length === 3,
      String(decisions.filter((decision) => decision.ok).length),
    );
  } finally {
    await prisma.rateLimit.deleteMany({ where: { key: limiterKey } });
  }

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
  const first = await settleManual(intent.providerRef, "PAID");
  check("طُبِّقت التسوية الأولى", first.applied);

  const afterFirst = await prisma.order.findUnique({
    where: { id: a.orderId },
    select: { status: true, aeOrders: { select: { aeOrderId: true } } },
  });
  check("أصبحت الطلبية مورَّدة", afterFirst?.status === "SOURCED", afterFirst?.status);
  const aeCount = afterFirst?.aeOrders.length ?? 0;
  check("أُنشئت طلبيات لدى المنصة", aeCount > 0);

  // ⚠️ جوهر الخمول: الإشعار المكرّر لا يشتري مرة ثانية
  const second = await settleManual(intent.providerRef, "PAID");
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
  await settleManual(bIntent.providerRef, "PAID");
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
  check(
    "المدفوعة غير قابلة للإلغاء قبل تنفيذ استرداد",
    !canCancel("PAID"),
  );
  check("المورَّدة غير قابلة للإلغاء", !canCancel("SOURCED"));
  check("المشحونة غير قابلة للإلغاء", !canCancel("SHIPPED"));
  check("المسلَّمة غير قابلة للإلغاء", !canCancel("DELIVERED"));

  const paidOnly = await makeOrder();
  await attachPaidProof(paidOnly.orderId, "cancel-boundary");
  await markOrderPaid(paidOnly.orderId);
  const paidOnlyCancel = await cancelOrder(paidOnly.orderId, {
    actor: "customer",
    reason: "يجب ألا يلغي الدفع بلا استرداد",
  });
  const paidOnlyAfter = await prisma.order.findUnique({
    where: { id: paidOnly.orderId },
    select: { status: true, cancelledAt: true },
  });
  check(
    "رُفض إلغاء طلبية PAID فعليًا",
    !paidOnlyCancel.ok && paidOnlyCancel.reason === "NOT_CANCELLABLE",
  );
  check(
    "لم تُطمس حالة PAID بإلغاء محلي",
    paidOnlyAfter?.status === "PAID" && paidOnlyAfter.cancelledAt == null,
    paidOnlyAfter?.status,
  );
  await cleanup(paidOnly.orderId);

  section("نيّة بوابة خارجية مفتوحة تمنع الإلغاء");
  const externalOpen = await makeOrder();
  const externalOpenIntent = await createPaymentIntent(externalOpen.orderId);
  // لا نتصل ببوابة حقيقية في سكربت التحقق. تغيير اسم المزوّد فقط يحاكي
  // حجزًا خارجيًا حيًا، وهو الحقل الذي يبني عليه حارس الإلغاء قراره.
  await prisma.paymentIntent.update({
    where: { id: externalOpenIntent.intentId },
    data: { provider: "tap" },
  });
  const externalOpenCancel = await cancelOrder(externalOpen.orderId, {
    actor: "customer",
    reason: "محاكاة ضغط الإلغاء أثناء صفحة الدفع",
  });
  const externalOpenAfter = await prisma.order.findUnique({
    where: { id: externalOpen.orderId },
    select: {
      status: true,
      cancelledAt: true,
      payments: {
        where: { id: externalOpenIntent.intentId },
        select: { status: true, provider: true },
      },
    },
  });
  check(
    "رُفض الإلغاء مع وجود نيّة خارجية مفتوحة",
    !externalOpenCancel.ok && externalOpenCancel.reason === "NOT_CANCELLABLE",
  );
  check(
    "بقي الطلب والنية مفتوحين للمطابقة مع البوابة",
    externalOpenAfter?.status === "PENDING_PAYMENT" &&
      externalOpenAfter.cancelledAt == null &&
      externalOpenAfter.payments[0]?.provider === "tap" &&
      ["REQUIRES_ACTION", "PENDING"].includes(
        externalOpenAfter.payments[0]?.status ?? "",
      ),
    `${externalOpenAfter?.status}/${externalOpenAfter?.payments[0]?.status}`,
  );
  await cleanup(externalOpen.orderId);

  section("سباق التسوية والإلغاء");
  const race = await makeOrder();
  const raceIntent = await createPaymentIntent(race.orderId);
  const raceProof = await prisma.paymentIntent.findUniqueOrThrow({
    where: { id: raceIntent.intentId },
    select: { amountSar: true, currency: true },
  });
  const verifiedPaidOutcome = {
    status: "PAID" as const,
    provider: "manual" as const,
    amountSar: Number(raceProof.amountSar),
    currency: raceProof.currency,
    payload: { source: "concurrent-security-verification" },
  };

  // إشعاران متماثلان + إلغاء في اللحظة نفسها: يفوز مسار واحد فقط تحت
  // قفل Order→PaymentIntent. الإشعار الصحيح لا يُسقط، والتوريد لا يتكرر.
  const [raceSettleA, raceSettleB, raceCancel] = await Promise.all([
    settleIntent(raceIntent.providerRef, verifiedPaidOutcome),
    settleIntent(raceIntent.providerRef, verifiedPaidOutcome),
    cancelOrder(race.orderId, {
      actor: "customer",
      reason: "اختبار سباق الدفع والإلغاء",
    }),
  ]);
  const raceAfter = await prisma.order.findUniqueOrThrow({
    where: { id: race.orderId },
    select: {
      status: true,
      needsManualReview: true,
      aeOrders: { select: { id: true } },
      payments: {
        where: { id: raceIntent.intentId },
        select: { status: true },
      },
    },
  });
  const appliedSettlements = Number(raceSettleA.applied) + Number(raceSettleB.applied);
  const cancellationWon = raceCancel.ok;
  const raceStateIsCoherent = cancellationWon
    ? raceAfter.status === "CANCELLED" &&
      raceAfter.needsManualReview &&
      raceAfter.aeOrders.length === 0
    : raceCancel.reason === "NOT_CANCELLABLE" &&
      raceAfter.status === "SOURCED" &&
      !raceAfter.needsManualReview &&
      raceAfter.aeOrders.length === 1;

  check(
    "طُبّقت نسخة واحدة فقط من إشعار الدفع المكرر",
    appliedSettlements === 1,
    String(appliedSettlements),
  );
  check(
    "لم يُسقط السباق إثبات الدفع الصحيح",
    raceAfter.payments[0]?.status === "PAID",
    raceAfter.payments[0]?.status,
  );
  check(
    "نتيجة السباق متماسكة: توريد واحد أو إلغاء مع مراجعة",
    raceStateIsCoherent,
    `${raceAfter.status}/review=${raceAfter.needsManualReview}/ae=${raceAfter.aeOrders.length}`,
  );
  check(
    "لم يحدث توريد مزدوج",
    raceAfter.aeOrders.length <= 1,
    String(raceAfter.aeOrders.length),
  );
  await cleanup(race.orderId);

  const c = await makeOrder();
  await attachPaidProof(c.orderId, "sourcing-boundary");
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
  await attachPaidProof(d.orderId, "state-transition");
  const firstPaid = await markOrderPaid(d.orderId);
  check("طُبِّق التحديد الأول", firstPaid);
  const secondPaid = await markOrderPaid(d.orderId);
  check("لم يُطبَّق التحديد الثاني (الحالة لم تعد بانتظار الدفع)", !secondPaid);
  await cleanup(d.orderId);

  section("حالة PAID بلا إثبات لا تسمح بالتوريد");
  const unproven = await makeOrder();
  // نحاكي صفًا تاريخيًا سبق إدخال PaymentIntent أو كتابةً يدوية خاطئة.
  await prisma.order.update({
    where: { id: unproven.orderId },
    data: { status: "PAID" },
  });
  const unprovenSource = await sourceOrderFromAliExpress(unproven.orderId);
  const unprovenAfter = await prisma.order.findUniqueOrThrow({
    where: { id: unproven.orderId },
    select: { needsManualReview: true, aeOrders: { select: { id: true } } },
  });
  check(
    "رُفض التوريد بلا PaymentIntent مدفوع",
    !unprovenSource.ok && unprovenSource.errorCode === "PAYMENT_PROOF_MISSING",
    unprovenSource.ok ? "نجح التوريد" : unprovenSource.errorCode,
  );
  check(
    "عُزل الطلب للمراجعة ولم يُنشأ طلب مورد",
    unprovenAfter.needsManualReview && unprovenAfter.aeOrders.length === 0,
  );
  await cleanup(unproven.orderId);

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
  const shortPay = await settleManual(
    fIntent.providerRef,
    "PAID",
    Number(fOrder?.totalSar ?? 0) - 100,
  );
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
  await settleManual(
    gIntent.providerRef,
    "PAID",
    Number(gTotal?.totalSar ?? 0),
  );
  // الاسترداد بعد الدفع: المزلاج العام يرفض ما بعد PAID، لكن REFUNDED استثناء
  const refund = await settleManual(gIntent.providerRef, "REFUNDED");
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
