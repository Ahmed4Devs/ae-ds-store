import "dotenv/config";
import {
  calculateTotals,
  effectiveFxRate,
  formatSar,
  retailUnitPriceSar,
  roundPrice,
} from "@/lib/pricing";
import {
  nationalAddressSchema,
  saudiPhoneSchema,
  shippingAddressSchema,
} from "@/lib/ksa";

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

console.log("\n=== تحقّق التسعير وقواعد السوق السعودي ===");

section("سعر الصرف");
const rate = effectiveFxRate();
check(
  "سعر الصرف الفعّال يشمل الهامش الاحتياطي",
  Math.abs(rate - 3.75 * 1.02) < 1e-9,
  `${rate.toFixed(4)}`,
);
console.log(`     3.75 + هامش 2٪ = ${rate.toFixed(4)} ريال للدولار`);

section("التقريب");
check("التقريب إلى أقرب 0.05", roundPrice(12.31, 0.05) === 12.3);
check("التقريب لأعلى عند المنتصف", roundPrice(12.33, 0.05) === 12.35);

section("سعر بيع الوحدة");
const unit = retailUnitPriceSar(12.86);
// 12.86 × 3.825 = 49.19 → +35٪ = 66.41 → تقريب 0.05
check("يطبّق الصرف ثم الهامش ثم التقريب", unit > 66 && unit < 67, `${unit}`);
console.log(`     تكلفة $12.86 ⟵⟶ سعر بيع ${formatSar(unit)}`);

section("حساب السلة — الشحن شامل الضريبة (ddpIncludeVATTax=true)");
const withVat = calculateTotals([
  {
    unitCostSource: 12.86,
    quantity: 2,
    shippingCostSource: 2.34,
    shippingIncludesVat: true,
  },
]);
check("الإجمالي أكبر من المجموع الفرعي", withVat.totalSar > withVat.subtotalSar);
check("الهامش موجب", withVat.marginSar > 0, `${withVat.marginSar}`);
console.log(
  `     فرعي ${formatSar(withVat.subtotalSar)} · شحن ${formatSar(withVat.shippingSar)} · ضريبة ${formatSar(withVat.vatSar)} · إجمالي ${formatSar(withVat.totalSar)} · هامش ${formatSar(withVat.marginSar)}`,
);

section("حساب السلة — الشحن غير شامل الضريبة");
const noVat = calculateTotals([
  {
    unitCostSource: 12.86,
    quantity: 2,
    shippingCostSource: 2.34,
    shippingIncludesVat: false,
  },
]);
check(
  "ضريبة أعلى حين لا يشمل الشحن الضريبة (تُحتسب عليه)",
  noVat.vatSar > withVat.vatSar,
  `${noVat.vatSar} مقابل ${withVat.vatSar}`,
);
console.log(
  `     الفرق في الضريبة: ${formatSar(noVat.vatSar - withVat.vatSar)} — تجاهل هذا الحقل يعني خسارة أو ازدواج`,
);

section("تثبيت سعر الصرف");
const fixed = calculateTotals(
  [{ unitCostSource: 10, quantity: 1, shippingCostSource: 1, shippingIncludesVat: true }],
  4.0,
);
check("سعر الصرف الممرَّر يتجاوز الافتراضي", fixed.fxRate === 4.0);
console.log(`     إعادة حساب طلبية قديمة بسعر صرف يومها: ${fixed.fxRate}`);

section("رقم الجوال السعودي");
for (const [input, expected] of [
  ["0512345678", "512345678"],
  ["512345678", "512345678"],
  ["+966512345678", "512345678"],
  ["00966512345678", "512345678"],
  ["05 1234 5678", "512345678"],
] as const) {
  const r = saudiPhoneSchema.safeParse(input);
  check(`تطبيع ${input}`, r.success && r.data === expected, r.success ? r.data : "فشل");
}
check("يرفض رقمًا غير سعودي", !saudiPhoneSchema.safeParse("0412345678").success);
check("يرفض رقمًا قصيرًا", !saudiPhoneSchema.safeParse("05123").success);

section("العنوان الوطني السعودي (nat_addr)");
check("يقبل RRDA2929", nationalAddressSchema.safeParse("RRDA2929").success);
check("يقبل ويحوّل حالة الأحرف", nationalAddressSchema.safeParse("rrda2929").data === "RRDA2929");
check("يرفض صيغة خاطئة", !nationalAddressSchema.safeParse("RRD2929").success);
check("يرفض أرقامًا فقط", !nationalAddressSchema.safeParse("12345678").success);

section("عنوان الشحن الكامل");
const addr = shippingAddressSchema.safeParse({
  fullName: "أحمد بن محمد",
  phone: "0512345678",
  province: "الرياض",
  city: "الرياض",
  addressLine1: "طريق الملك فهد، حي العليا، مبنى 7",
  postalCode: "12211",
  nationalAddress: "rrda2929",
});
check("يقبل عنوانًا سعوديًا صحيحًا", addr.success, addr.success ? "" : JSON.stringify(addr.error.issues[0]));
if (addr.success) {
  check("يطبّع الجوال", addr.data.phone === "512345678");
  check("يحوّل العنوان الوطني لأحرف كبيرة", addr.data.nationalAddress === "RRDA2929");
  check("يضبط الدولة SA", addr.data.country === "SA");
}
check(
  "يرفض منطقة غير سعودية",
  !shippingAddressSchema.safeParse({
    fullName: "أحمد",
    phone: "0512345678",
    province: "دبي",
    city: "دبي",
    addressLine1: "شارع الشيخ زايد 12",
  }).success,
);

console.log(`\n${"═".repeat(62)}`);
console.log(`  نجح: ${passed}   |   فشل: ${failed}`);
console.log(`${"═".repeat(62)}\n`);
if (failed > 0) process.exit(1);
