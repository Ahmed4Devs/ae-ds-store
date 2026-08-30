import "dotenv/config";
import { buildSignBase, signRequest } from "@/lib/aliexpress/signature";
import {
  getCategories,
  getOrderDetail,
  getProduct,
  getShippingOptions,
  getTracking,
  placeOrder,
  searchProducts,
} from "@/lib/aliexpress/api";
import { AeApiError } from "@/lib/aliexpress/errors";

/**
 * تحقّق من طبقة تكامل AliExpress.
 * يُشغَّل بـ: npm run verify:ae
 */

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

async function main() {
  console.log("\n=== تحقّق طبقة تكامل AliExpress ===");
  console.log(`الوضع: ${process.env.AE_MODE}`);

  // ---------------------------------------------------------------------
  section("خوارزمية التوقيع (المستند 836)");

  // المثال الحرفي من التوثيق:
  //   قبل الترتيب: foo:1, bar:2, foo_bar:3, foobar:4
  //   بعد الترتيب: bar:2, foo:1, foo_bar:3, foobar:4
  //   الدمج:      bar2foo1foo_bar3foobar4
  //   مع الاسم:   testAPIbar2foo1foo_bar3foobar4
  const base = buildSignBase("testAPI", {
    foo: 1,
    bar: 2,
    foo_bar: 3,
    foobar: 4,
  });
  check(
    "السلسلة الأساسية تطابق مثال التوثيق حرفيًا",
    base === "testAPIbar2foo1foo_bar3foobar4",
    `النتيجة: ${base}`,
  );

  check(
    "المُعامل sign مستبعَد من حساب التوقيع",
    buildSignBase("api", { a: 1, sign: "XYZ" }) === "apia1",
  );

  check(
    "القيم الفارغة مستبعَدة",
    buildSignBase("api", { a: 1, b: "", c: null, d: undefined }) === "apia1",
  );

  const sig = signRequest("testAPI", { foo: 1, bar: 2 }, "secret");
  check(
    "التوقيع ست عشري بأحرف كبيرة بطول 64",
    /^[0-9A-F]{64}$/.test(sig),
    sig.slice(0, 16) + "…",
  );

  // ---------------------------------------------------------------------
  section("البحث — ds.text.search");
  const search = await searchProducts({ keyword: "", pageSize: 5 });
  check("يعيد منتجات", search.items.length > 0, `العدد: ${search.items.length}`);
  check("لكل منتج معرّف وسعر", search.items.every((i) => i.aeProductId && i.sourcePrice > 0));
  const first = search.items[0];
  console.log(`     مثال: ${first.title.slice(0, 50)} — $${first.sourcePrice}`);

  // ---------------------------------------------------------------------
  section("تفاصيل المنتج — ds.product.get");
  const product = await getProduct(first.aeProductId);
  check("يعيد وحدات SKU", product.skus.length > 0, `العدد: ${product.skus.length}`);
  check(
    "كل SKU يحمل skuAttr غير فارغ (الحقل المطلوب لإنشاء الطلبية)",
    product.skus.every((s) => s.skuAttr.length > 0),
  );
  check(
    "skuAttr مختلف عن aeSkuId (خطأ شائع يُفشل الطلبيات)",
    product.skus.every((s) => s.skuAttr !== s.aeSkuId),
  );
  console.log(`     skuAttr: ${product.skus[0].skuAttr}`);
  console.log(`     aeSkuId: ${product.skus[0].aeSkuId}`);

  // ---------------------------------------------------------------------
  section("الشحن — ds.freight.query");
  const options = await getShippingOptions({
    aeProductId: first.aeProductId,
    quantity: 1,
  });
  check("يعيد خيارات شحن", options.length > 0, `العدد: ${options.length}`);
  check("لكل خيار رمز code", options.every((o) => o.code.length > 0));
  const untracked = options.filter((o) => !o.hasTracking);
  check(
    "يميّز الخيارات غير القابلة للتتبع",
    untracked.length > 0,
    `بلا تتبع: ${untracked.map((o) => o.code).join(", ") || "لا يوجد"}`,
  );
  for (const o of options) {
    console.log(
      `     ${o.code.padEnd(26)} $${String(o.feeSource).padStart(6)} · ${o.minDays}-${o.maxDays} يومًا · تتبع=${o.hasTracking ? "نعم" : "لا"} · ضريبة=${o.includesVat ? "شامل" : "غير شامل"}`,
    );
  }

  // ---------------------------------------------------------------------
  section("إنشاء الطلبية — ds.order.create");
  const trackable = options.find((o) => o.hasTracking)!;
  const outOrderId = `VERIFY-${Date.now()}`;
  const address = {
    country: "SA",
    province: "الرياض",
    city: "الرياض",
    addressLine1: "طريق الملك فهد، حي العليا، مبنى 7",
    postalCode: "12211",
    fullName: "أحمد التجريبي",
    phone: "512345678",
    phoneCountry: "+966",
    nationalAddress: "RRDA2929",
  };

  const placed = await placeOrder({
    outOrderId,
    address,
    items: [
      {
        aeProductId: first.aeProductId,
        skuAttr: product.skus[0].skuAttr,
        quantity: 1,
        logisticsServiceName: trackable.code,
      },
    ],
    tryToPay: false,
  });
  check("أُنشئت الطلبية", placed.aeOrderIds.length > 0, placed.aeOrderIds.join(", "));
  check("order_list يُعامَل كمصفوفة", Array.isArray(placed.aeOrderIds));

  // منع التكرار
  let duplicateCaught = false;
  try {
    await placeOrder({
      outOrderId,
      address,
      items: [
        {
          aeProductId: first.aeProductId,
          skuAttr: product.skus[0].skuAttr,
          quantity: 1,
          logisticsServiceName: trackable.code,
        },
      ],
      tryToPay: false,
    });
  } catch (e) {
    if (e instanceof AeApiError) {
      duplicateCaught = e.code === "REPEATED_ORDER_ERROR";
      check(
        "إعادة الإرسال بنفس out_order_id تُرفض بـ REPEATED_ORDER_ERROR",
        duplicateCaught,
        e.code,
      );
      check("الخطأ مصنّف DUPLICATE ولا يُعاد آليًا", e.errorClass === "DUPLICATE" && e.isFatal);
    }
  }
  if (!duplicateCaught) check("منع التكرار يعمل", false, "لم يُرفَع خطأ");

  // رمز شحن غير صالح
  try {
    await placeOrder({
      outOrderId: `VERIFY-BAD-${Date.now()}`,
      address,
      items: [
        {
          aeProductId: first.aeProductId,
          skuAttr: product.skus[0].skuAttr,
          quantity: 1,
          logisticsServiceName: "",
        },
      ],
    });
    check("رمز شحن فارغ يُرفض", false, "لم يُرفَع خطأ");
  } catch (e) {
    const err = e as AeApiError;
    check(
      "رمز شحن فارغ يُرفض بـ DELIVERY_METHOD_NOT_EXIST",
      err.code === "DELIVERY_METHOD_NOT_EXIST",
      err.code,
    );
    check("مصنّف REFRESH_THEN_RETRY", err.needsRefresh);
  }

  // عنوان ناقص
  try {
    await placeOrder({
      outOrderId: `VERIFY-ADDR-${Date.now()}`,
      address: { ...address, city: "" },
      items: [
        {
          aeProductId: first.aeProductId,
          skuAttr: product.skus[0].skuAttr,
          quantity: 1,
          logisticsServiceName: trackable.code,
        },
      ],
    });
    check("عنوان ناقص يُرفض", false, "لم يُرفَع خطأ");
  } catch (e) {
    const err = e as AeApiError;
    check(
      "عنوان ناقص يُرفض بخطأ التحقق",
      err.code === "B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL",
      err.code,
    );
    check("له رسالة عربية آمنة للعميل", err.customerMessage.length > 0);
  }

  // ---------------------------------------------------------------------
  section("تفاصيل الطلبية — trade.ds.order.get");
  const detail = await getOrderDetail(placed.aeOrderIds[0]);
  check("يعيد حالة الطلبية", Boolean(detail.orderStatus), detail.orderStatus ?? "");
  check(
    "يعيد pay_timeout_second (لمراقبة الإلغاء التلقائي)",
    detail.payTimeoutSecond !== null,
    `${detail.payTimeoutSecond} ثانية`,
  );

  // ---------------------------------------------------------------------
  section("التتبع — ds.order.tracking.get");
  const tracking = await getTracking(placed.aeOrderIds[0]);
  check(
    "غياب بيانات التتبع قبل الشحن يُعالَج كقائمة فارغة لا كخطأ",
    Array.isArray(tracking),
    `عدد الطرود: ${tracking.length}`,
  );

  // ---------------------------------------------------------------------
  section("الفئات — ds.category.get");
  const cats = await getCategories();
  check("يعيد فئات", cats.length > 0, `العدد: ${cats.length}`);

  // ---------------------------------------------------------------------
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  نجح: ${passed}   |   فشل: ${failed}`);
  console.log(`${"═".repeat(64)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n✗ فشل التحقق:", e);
  process.exit(1);
});
