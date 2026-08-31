import "dotenv/config";

/**
 * تحقّق من طبقة TanStack Query عبر مسارات API الحقيقية.
 * يتطلّب خادمًا يعمل: npm run start (أو dev)
 *
 * يُشغَّل بـ: npm run verify:query
 */

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";

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
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
}

interface ShippingDto {
  code: string;
  feeSar: number;
  hasTracking: boolean;
  estimate: string;
}

async function main() {
  console.log("\n=== تحقّق طبقة TanStack Query ===");
  console.log(`الخادم: ${BASE}`);

  // -------------------------------------------------------------------
  section("مسار الشحن — إعادة الحساب حسب الكمية");

  const fees: number[] = [];
  for (const q of [1, 3, 10]) {
    const res = await fetch(
      `${BASE}/api/shipping?productId=1005006891234501&quantity=${q}`,
    );
    check(`كمية ${q}: استجابة ناجحة`, res.ok, `HTTP ${res.status}`);
    const data = (await res.json()) as ShippingDto[];
    const std = data.find((o) => o.code === "CAINIAO_FULFILLMENT_STD");
    if (std) fees.push(std.feeSar);
  }

  check(
    "الأجرة تزيد بزيادة الكمية (العيب الذي كان قائمًا)",
    fees.length === 3 && fees[0] < fees[1] && fees[1] < fees[2],
    fees.map((f) => f.toFixed(2)).join(" < "),
  );

  const res1 = await fetch(
    `${BASE}/api/shipping?productId=1005006891234501&quantity=1`,
  );
  const opts = (await res1.json()) as ShippingDto[];
  check("يميّز الخيارات غير القابلة للتتبع", opts.some((o) => !o.hasTracking));
  check("لكل خيار مدة تسليم معلنة", opts.every((o) => o.estimate.length > 0));

  // -------------------------------------------------------------------
  section("التحقق من المدخلات");

  for (const [label, url, expected] of [
    ["معرّف منتج فارغ", "/api/shipping?productId=&quantity=1", 400],
    ["كمية خارج النطاق", "/api/shipping?productId=X&quantity=999", 400],
    ["كمية غير رقمية", "/api/shipping?productId=X&quantity=abc", 400],
  ] as const) {
    const r = await fetch(`${BASE}${url}`);
    check(`${label} يُرفض بـ ${expected}`, r.status === expected, `HTTP ${r.status}`);
  }

  // -------------------------------------------------------------------
  section("الحماية");

  const admin = await fetch(`${BASE}/api/admin/orders`);
  check("لوحة الإدارة محمية بلا جلسة", admin.status === 403, `HTTP ${admin.status}`);

  const missing = await fetch(`${BASE}/api/orders/AE-DOES-NOT-EXIST/tracking`);
  check(
    "طلبية غير موجودة تُعيد 404 لا 500",
    missing.status === 404,
    `HTTP ${missing.status}`,
  );

  // -------------------------------------------------------------------
  section("دخول المسؤول والوصول المصرّح");

  const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({
      email: "admin@ae-ds-store.local",
      password: "Admin12345",
    }),
  });
  check("تسجيل الدخول ينجح", login.ok, `HTTP ${login.status}`);

  const cookie = login.headers.getSetCookie().join("; ");
  const adminOk = await fetch(`${BASE}/api/admin/orders`, {
    headers: { Cookie: cookie },
  });
  check("المسؤول يصل إلى بياناته", adminOk.ok, `HTTP ${adminOk.status}`);

  const payload = (await adminOk.json()) as {
    rows: unknown[];
    stats: { totalOrders: number };
  };
  check("الاستجابة تحمل الصفوف والإحصاءات", Array.isArray(payload.rows) && typeof payload.stats?.totalOrders === "number");

  console.log(`\n${"═".repeat(58)}`);
  console.log(`  نجح: ${passed}   |   فشل: ${failed}`);
  console.log(`${"═".repeat(58)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n✗ فشل التحقق — تأكّد أن الخادم يعمل:", e);
  process.exit(1);
});
