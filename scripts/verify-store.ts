// أوّل استيراد عمدًا: يضبط مفاتيح الاختبار قبل أن يُنشئ lib/db عميلَ Prisma
// (الذي يقرأ env() عند الاستيراد فيُخزّنها). راجع scripts/verify-setup.ts.
import "./verify-setup";
import { prisma } from "@/lib/db";
import { currentFxRate, effectiveFxRateAsync, fxHistory, recordFxRate } from "@/lib/fx";
import { publishedCards } from "@/lib/catalog";
import { effectiveFxRate, retailUnitPriceSar } from "@/lib/pricing";
import { getTokenState, refreshAccessToken, seedTokenFromEnv } from "@/lib/aliexpress/token";
import { buildZatcaTlv } from "@/lib/zatca";
import { tapProvider } from "@/lib/payments/tap";
import { createHmac } from "node:crypto";
import { env } from "@/lib/env";

/**
 * تحقّق من الإعدادات التشغيلية: سعر الصرف من القاعدة، هامش المنتج،
 * النشر في الكتالوج، تجديد التفويض، ورمز الفاتورة الضريبية.
 * يُشغَّل بـ: npm run verify:store
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

/** يفكّ ترميز TLV للتحقق من البنية والأطوال. */
function parseTlv(base64: string): Array<{ tag: number; value: string }> {
  const buf = Buffer.from(base64, "base64");
  const out: Array<{ tag: number; value: string }> = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    const value = buf.subarray(i + 2, i + 2 + len).toString("utf8");
    out.push({ tag, value });
    i += 2 + len;
  }
  return out;
}

async function main() {
  console.log("\n=== تحقّق الإعدادات التشغيلية ===");

  section("المخطّط المستهدف في قاعدة البيانات");
  let schemaOk = true;
  try {
    await prisma.fxRate.count();
  } catch {
    schemaOk = false;
  }
  check("Prisma يستعلم في المخطّط الصحيح لا في public", schemaOk);

  // ================================================================
  section("سعر الصرف من قاعدة البيانات");
  const before = await currentFxRate();
  check("يوجد سعر فعّال دائمًا", before > 0);

  const marker = 3.9123;
  // ⚠️ try/finally حول علامة الصرف: تكتب هذه الفحوص سعرًا وهميًّا في جدول
  // FxRate الحيّ، وسقوطُ السكربت بينها وبين حذفها كان يترك العلامة سعرًا
  // للمتجر كلّه. finally يضمن الحذف مهما فشل فحصٌ في الوسط.
  try {
    await recordFxRate(marker, "verify-store");
    const after = await currentFxRate();
    check("السعر المخزَّن يتقدّم على قيمة البيئة", Math.abs(after - marker) < 1e-6,
      `${after}`);

    const eff = await effectiveFxRateAsync();
    const expected = marker * (1 + env().FX_BUFFER_PERCENT / 100);
    check("الهامش الاحتياطي مطبَّق على السعر المخزَّن",
      Math.abs(eff - expected) < 1e-6, `${eff} ≠ ${expected}`);

    // effectiveFxRate المتزامنة تبقى مصدر البيئة — لها مستدعون متزامنون
    check("النسخة المتزامنة ما زالت تقرأ البيئة",
      Math.abs(effectiveFxRate() - env().FX_USD_TO_SAR * (1 + env().FX_BUFFER_PERCENT / 100)) < 1e-6);

    const history = await fxHistory(5);
    check("السجلّ يحفظ التاريخ لا القيمة الأخيرة فقط", history.length >= 1);
    check("أحدث صفّ هو المسجَّل للتوّ", Math.abs(history[0].rate - marker) < 1e-6);

    section("رفض سعر صرف غير معقول");
    // 375 بدل 3.75 يُسعّر الكتالوج كله بمئة ضعف — يجب أن يُرفض لا أن يُحفظ
    let rejected = false;
    try {
      await recordFxRate(375, "verify-store");
    } catch {
      rejected = true;
    }
    check("رُفض سعر خارج النطاق المعقول", rejected, "لم يُرفَض");
  } finally {
    await prisma.fxRate.deleteMany({ where: { source: "verify-store" } });
  }

  // ================================================================
  section("هامش الربح الخاص بالمنتج");
  const defaultMargin = env().DEFAULT_MARGIN_PERCENT;
  const base = 10;
  const withDefault = retailUnitPriceSar(base, { fxRate: 4 });
  const withOverride = retailUnitPriceSar(base, {
    fxRate: 4,
    marginPercent: defaultMargin + 50,
  });
  check("الهامش الخاص يغيّر السعر فعلًا", withOverride > withDefault,
    `${withOverride} ≤ ${withDefault}`);

  // ================================================================
  section("النشر في الكتالوج");
  const publishedBefore = await prisma.product.count({ where: { isPublished: true } });
  const listBefore = await publishedCards({ pageSize: 100 });
  check("عدد البطاقات المنشورة لا يتجاوز عدد المنشور",
    listBefore.cards.length <= publishedBefore);
  check("لا تُعرض إلا المنشورة", listBefore.total === publishedBefore,
    `${listBefore.total} ≠ ${publishedBefore}`);

  const sample = await prisma.product.findFirst({
    where: { skus: { some: {} } },
    select: { id: true, isPublished: true },
  });

  if (sample) {
    await prisma.product.update({
      where: { id: sample.id },
      data: { isPublished: false },
    });
    const hidden = await publishedCards({ pageSize: 100 });
    check("المخفي لا يظهر في المختارات", hidden.total === publishedBefore - (sample.isPublished ? 1 : 0));

    await prisma.product.update({
      where: { id: sample.id },
      data: { isPublished: true },
    });
    const shown = await publishedCards({ pageSize: 100 });
    check("المنشور يظهر في المختارات",
      shown.total === (sample.isPublished ? publishedBefore : publishedBefore + 1));

    // إعادة الحالة الأصلية
    await prisma.product.update({
      where: { id: sample.id },
      data: { isPublished: sample.isPublished },
    });
  } else {
    console.log("     تخطٍّ — لا توجد منتجات في المرآة بعد (شغّل npm run db:seed)");
  }

  // ================================================================
  section("تفويض AliExpress");
  if (env().AE_MODE === "mock") {
    console.log("     وضع المحاكاة — التجديد يسلك المسار نفسه ببيانات وهمية");
  }

  const seeded = await seedTokenFromEnv();
  check("استُوردت البذرة من البيئة (أو لا رمز في البيئة)",
    seeded || env().AE_ACCESS_TOKEN === "");

  if (seeded) {
    const state = await getTokenState();
    check("حالة التفويض تُقرأ", state.present);

    const refreshed = await refreshAccessToken();
    // في وضع المحاكاة يجب أن ينجح التجديد؛ في الوضع الحقيقي قد يفشل
    // بمفاتيح تجريبية، فنقبل الفشل هناك ما دام مُبلَّغًا لا صامتًا.
    if (env().AE_MODE === "mock") {
      check("نجح تجديد الرمز في المحاكاة", refreshed.ok,
        refreshed.ok ? "" : refreshed.message);
      if (refreshed.ok) {
        const after2 = await getTokenState();
        check("سُجّل وقت التجديد", after2.lastRefreshedAt != null);
        check("سُجّل تاريخ الانتهاء", after2.expiresAt != null);
      }
    } else {
      check("نتيجة التجديد مُبلَّغة لا صامتة",
        refreshed.ok || refreshed.message.length > 0);
    }
  }

  // ================================================================
  section("رمز الفاتورة الضريبية (ZATCA)");
  const issuedAt = new Date("2026-09-02T12:30:00.000Z");
  const tlv = buildZatcaTlv({
    sellerName: "متجر الوصل",
    vatNumber: "310000000000003",
    issuedAt,
    totalWithVat: 373.55,
    vatTotal: 48.72,
  });

  check("الناتج base64 صالح", /^[A-Za-z0-9+/]+={0,2}$/.test(tlv));

  const fields = parseTlv(tlv);
  check("خمسة حقول بالضبط", fields.length === 5, `${fields.length}`);
  check("الوسوم بالترتيب 1..5",
    fields.every((f, i) => f.tag === i + 1),
    fields.map((f) => f.tag).join(","));
  check("الحقل 1 اسم البائع", fields[0]?.value === "متجر الوصل");
  check("الحقل 2 الرقم الضريبي", fields[1]?.value === "310000000000003");
  // المواصفة تطلب دقّة الثانية بلا أجزائها؛ toISOString يضيف ثلاث خانات
  // ميلي ثانية لا تقبلها بعض قارئات الهيئة.
  check("الحقل 3 طابع زمني ISO بدقّة الثانية",
    fields[2]?.value === "2026-09-02T12:30:00Z", fields[2]?.value);
  check("لا أجزاء ثانية في الطابع الزمني",
    !/\.\d{3}/.test(fields[2]?.value ?? ""));
  check("الحقل 4 الإجمالي بخانتين عشريتين", fields[3]?.value === "373.55");
  check("الحقل 5 الضريبة بخانتين عشريتين", fields[4]?.value === "48.72");

  // ⚠️ الفحص الحاسم: الطول بالبايتات لا بالمحارف. اسم البائع العربي
  // متعدّد البايتات، واستعمال .length هنا يُنتج رمزًا لا يُقرأ بالماسح.
  const nameBytes = Buffer.byteLength("متجر الوصل", "utf8");
  const raw = Buffer.from(tlv, "base64");
  check("طول الحقل محسوب بالبايتات لا بالمحارف",
    raw[1] === nameBytes,
    `${raw[1]} ≠ ${nameBytes}`);

  // ================================================================
  section("توقيع إشعار Tap (HMAC لا سرّ ثابت)");
  // يتحقق أن verifyWebhook يقبل توقيعًا محسوبًا صحيحًا ويرفض السرّ الثابت
  // ويرفض توقيعًا مزوّرًا — العطل السابق كان يقارن السرّ الثابت فيفشل دائمًا.
  const secret = env().TAP_SECRET_KEY;
  const charge = {
    id: "chg_test_1",
    status: "CAPTURED",
    amount: 373.55,
    currency: "SAR",
    reference: { gateway: "g1", payment: "p1" },
    transaction: { created: "1700000000000" },
  };
  const tapBase =
    `x_id${charge.id}` +
    `x_amount${charge.amount.toFixed(2)}` +
    `x_currency${charge.currency}` +
    `x_gateway_reference${charge.reference.gateway}` +
    `x_payment_reference${charge.reference.payment}` +
    `x_status${charge.status}` +
    `x_created${charge.transaction.created}`;
  const goodHash = createHmac("sha256", secret).update(tapBase).digest("hex");
  const tapRaw = JSON.stringify(charge);

  const okEvent = await tapProvider.verifyWebhook(
    new Request("https://x", { headers: { hashstring: goodHash } }),
    tapRaw,
  );
  check("قُبل توقيع HMAC صحيح", okEvent != null && okEvent.status === "PAID");
  check("استُخرج المبلغ من الإشعار", okEvent?.amountSar === 373.55);

  const staticEvent = await tapProvider.verifyWebhook(
    new Request("https://x", {
      headers: { hashstring: "static-secret-should-not-match" },
    }),
    tapRaw,
  );
  check("رُفض السرّ الثابت (لا يساوي HMAC)", staticEvent === null);

  const forgedEvent = await tapProvider.verifyWebhook(
    new Request("https://x", { headers: { hashstring: "deadbeef" } }),
    tapRaw,
  );
  check("رُفض توقيع مزوَّر", forgedEvent === null);

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
