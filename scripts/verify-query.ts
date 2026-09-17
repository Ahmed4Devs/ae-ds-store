import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * تحقّق من طبقة TanStack Query عبر مسارات API الحقيقية.
 * يتطلّب خادمًا يعمل: npm run start (أو dev)
 *
 * يُشغَّل بـ: npm run verify:query
 */

const configuredBase = new URL(
  process.env.VERIFY_BASE_URL ?? "http://localhost:3000",
);
if (
  !["http:", "https:"].includes(configuredBase.protocol) ||
  configuredBase.username ||
  configuredBase.password ||
  configuredBase.search ||
  configuredBase.hash
) {
  throw new Error("VERIFY_BASE_URL يجب أن يكون أصل http(s) بلا بيانات اعتماد أو query");
}
const BASE = configuredBase.origin;

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(label: string, detail: string): void {
  skipped++;
  console.log(`  ↷ ${label} — ${detail}`);
}

function mergeResponseCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

interface ShippingDto {
  code: string;
  feeSar: number;
  hasTracking: boolean;
  estimate: string;
}

interface QueryTrace {
  verb: string;
  targets: string[];
}

function resetQueryTrace(): boolean {
  const path = process.env.VERIFY_QUERY_TRACE_FILE;
  if (!path) return false;
  writeFileSync(path, "", "utf8");
  return true;
}

function readQueryTrace(): QueryTrace[] {
  const path = process.env.VERIFY_QUERY_TRACE_FILE;
  if (!path) return [];
  const body = readFileSync(path, "utf8").trim();
  if (!body) return [];
  return body.split("\n").flatMap((line): QueryTrace[] => {
    try {
      const parsed = JSON.parse(line) as Partial<QueryTrace>;
      return typeof parsed.verb === "string" && Array.isArray(parsed.targets)
        ? [{ verb: parsed.verb, targets: parsed.targets }]
        : [];
    } catch {
      return [];
    }
  });
}

async function main() {
  console.log("\n=== تحقّق طبقة TanStack Query ===");
  console.log(`الخادم: ${BASE}`);

  // -------------------------------------------------------------------
  section("الصفحة الرئيسية — الأمان وميزانية الطلبات");

  const tracingEnabled = resetQueryTrace();
  const home = await fetch(`${BASE}/`, {
    headers: { Accept: "text/html", "User-Agent": "HomepageBudgetCheck/1.0" },
  });
  const homeHtml = await home.text();
  check("الصفحة الرئيسية تستجيب بنجاح", home.ok, `HTTP ${home.status}`);
  check(
    "نوع محتوى الصفحة HTML صريح",
    home.headers.get("content-type")?.toLowerCase().startsWith("text/html") === true,
  );

  const csp = home.headers.get("content-security-policy") ?? "";
  check(
    "CSP تمنع الإطارات والكائنات وتقيّد الأصل الافتراضي",
    csp.includes("default-src 'self'") &&
      csp.includes("frame-ancestors 'none'") &&
      csp.includes("object-src 'none'"),
  );
  check(
    "ترويسات منع MIME sniffing والإطارات مفعلة",
    home.headers.get("x-content-type-options") === "nosniff" &&
      home.headers.get("x-frame-options") === "DENY",
  );
  check(
    "سياسة الصلاحيات تمنع الكاميرا والميكروفون والموقع",
    ["camera=()", "microphone=()", "geolocation=()"].every((value) =>
      (home.headers.get("permissions-policy") ?? "").includes(value),
    ),
  );
  check(
    "HTML الأولي ضمن ميزانية 256KiB",
    Buffer.byteLength(homeHtml, "utf8") <= 256 * 1024,
    `${Buffer.byteLength(homeHtml, "utf8")} bytes`,
  );

  const declaredResources = new Set(
    [...homeHtml.matchAll(/(?:src|href)="([^"]+)"/giu)]
      .map((match) => match[1])
      .filter(
        (value) =>
          value.startsWith("/_next/") ||
          /^\/(?:favicon\.ico|icon\.svg)(?:\?|$)/u.test(value),
      ),
  );
  check(
    "الأصول المعلنة في HTML لا تتجاوز 30 طلبًا",
    declaredResources.size <= 30,
    String(declaredResources.size),
  );
  const externalExecutableResources = [
    ...homeHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/giu),
  ]
    .map((match) => match[1])
    .filter((value) => /^https?:\/\//iu.test(value));
  check(
    "لا تحمل الصفحة سكربتات أو أنماطًا تنفيذية من أصل خارجي",
    externalExecutableResources.length === 0,
  );

  if (!tracingEnabled) {
    skip(
      "ميزانية Queries للصفحة الرئيسية",
      "تعمل داخل verify:query:isolated فقط",
    );
  } else {
    const trace = readQueryTrace();
    const fxReads = trace.filter(
      (entry) => entry.verb === "SELECT" && entry.targets.includes("FxRate"),
    ).length;
    const apiLogWrites = trace.filter(
      (entry) => entry.verb === "INSERT" && entry.targets.includes("AeApiLog"),
    ).length;
    const unexpected = trace.filter(
      (entry) =>
        !(
          (entry.verb === "SELECT" && entry.targets.includes("FxRate")) ||
          (entry.verb === "INSERT" && entry.targets.includes("AeApiLog"))
        ),
    );
    check("الصفحة تقرأ سعر الصرف مرة واحدة", fxReads === 1, String(fxReads));
    check(
      "الصفحة تسجل استدعاءَي البحث والفئات فقط",
      apiLogWrites === 2,
      String(apiLogWrites),
    );
    check(
      "إجمالي Queries المجهولة للصفحة لا يتجاوز ثلاثة",
      trace.length === 3 && unexpected.length === 0,
      `${trace.length} total / ${unexpected.length} unexpected`,
    );
  }

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
    [
      "معامل كمية مكرر",
      "/api/shipping?productId=1005006891234501&quantity=1&quantity=2",
      400,
    ],
    [
      "معامل مجهول",
      "/api/shipping?productId=1005006891234501&quantity=1&admin=true",
      400,
    ],
  ] as const) {
    const r = await fetch(`${BASE}${url}`);
    check(`${label} يُرفض بـ ${expected}`, r.status === expected, `HTTP ${r.status}`);
  }

  // -------------------------------------------------------------------
  section("فحص HTTP هجومي محدود");

  const shippingPost = await fetch(`${BASE}/api/shipping`, { method: "POST" });
  check(
    "مسار القراءة يرفض POST",
    shippingPost.status === 405,
    `HTTP ${shippingPost.status}`,
  );

  const webhookGet = await fetch(`${BASE}/api/payments/webhook`);
  check(
    "مسار webhook يرفض GET",
    webhookGet.status === 405,
    `HTTP ${webhookGet.status}`,
  );

  const webhookWrongType = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not-json",
  });
  check(
    "webhook يرفض نوع المحتوى الخاطئ",
    webhookWrongType.status === 415,
    `HTTP ${webhookWrongType.status}`,
  );
  check(
    "رد webhook الحساس غير قابل للتخزين",
    (webhookWrongType.headers.get("cache-control") ?? "").includes("no-store"),
  );

  const compressedAuth = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      Origin: BASE,
    },
    body: "{}",
  });
  check(
    "أجسام المصادقة المضغوطة مرفوضة قبل فكها",
    compressedAuth.status === 415,
    `HTTP ${compressedAuth.status}`,
  );

  const oversizedWebhook = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
  });
  check(
    "webhook يرفض جسمًا يتجاوز 64KiB",
    oversizedWebhook.status === 413,
    `HTTP ${oversizedWebhook.status}`,
  );

  const hostileOrigin = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.invalid",
    },
    body: JSON.stringify({
      email: "nobody@example.invalid",
      password: "irrelevant-password",
    }),
  });
  check(
    "المصادقة ترفض أصلًا خارجيًا (CSRF)",
    hostileOrigin.status === 403,
    `HTTP ${hostileOrigin.status}`,
  );
  check(
    "لا يسمح CORS للأصل المهاجم",
    hostileOrigin.headers.get("access-control-allow-origin") !==
      "https://attacker.invalid",
  );

  const injectedNonce = "attacker-controlled-nonce";
  const nonceA = await fetch(`${BASE}/`, { headers: { "x-nonce": injectedNonce } });
  const nonceB = await fetch(`${BASE}/`, { headers: { "x-nonce": injectedNonce } });
  const cspA = nonceA.headers.get("content-security-policy") ?? "";
  const cspB = nonceB.headers.get("content-security-policy") ?? "";
  check(
    "قيمة nonce يرسلها العميل لا تنعكس في CSP",
    !cspA.includes(injectedNonce) && !cspB.includes(injectedNonce),
  );
  check("CSP تستخدم nonce جديدًا لكل طلب", cspA !== cspB);

  const resetToken = "A".repeat(24);
  const poisonedHost = await fetch(`${BASE}/reset-password?token=${resetToken}`, {
    redirect: "manual",
    headers: { "X-Forwarded-Host": "attacker.invalid" },
  });
  const poisonedLocation = poisonedHost.headers.get("location") ?? "";
  const poisonedRedirectUrl = new URL(poisonedLocation, BASE);
  check(
    "المضيف المحقون لا يغيّر أصل تحويل استعادة كلمة المرور",
    poisonedHost.status === 303 &&
      poisonedRedirectUrl.origin === BASE &&
      !poisonedLocation.includes("attacker.invalid"),
    `HTTP ${poisonedHost.status}`,
  );

  const resetCapture = await fetch(`${BASE}/reset-password?token=${resetToken}`, {
    redirect: "manual",
  });
  const resetLocation = resetCapture.headers.get("location") ?? "";
  const resetCookies = resetCapture.headers.getSetCookie().join(";");
  const normalizedResetCookies = resetCookies.toLowerCase();
  const resetRedirectUrl = new URL(resetLocation, BASE);
  check(
    "تحويل رمز الاستعادة يستخدم الأصل الموثوق ولا يكشف الرمز",
    resetCapture.status === 303 &&
      resetRedirectUrl.origin === BASE &&
      resetRedirectUrl.pathname === "/reset-password" &&
      resetRedirectUrl.search === "" &&
      !resetLocation.includes("attacker.invalid"),
    `HTTP ${resetCapture.status}`,
  );
  check(
    "رمز الاستعادة ينتقل إلى كوكي HttpOnly مقيّدة",
    normalizedResetCookies.includes("httponly") &&
      normalizedResetCookies.includes("samesite=lax") &&
      normalizedResetCookies.includes("path=/reset-password") &&
      !resetLocation.includes(resetToken),
  );

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

  const cronSecret = process.env.VERIFY_CRON_SECRET;
  if (!cronSecret) {
    skip(
      "حماية وتشغيل المهمة المجدولة",
      "اختياري؛ اضبط VERIFY_CRON_SECRET وقت التشغيل فقط",
    );
  } else {
    const wrongSecret = `${cronSecret[0] === "0" ? "1" : "0"}${cronSecret.slice(1)}`;
    const deniedCron = await fetch(`${BASE}/api/cron/sync-orders`, {
      headers: { Authorization: `Bearer ${wrongSecret}` },
    });
    check(
      "المهمة المجدولة ترفض Bearer خاطئًا",
      deniedCron.status === 401,
      `HTTP ${deniedCron.status}`,
    );

    const allowedCron = await fetch(`${BASE}/api/cron/sync-orders`, {
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    check(
      "المهمة المجدولة تقبل Bearer الصحيح",
      allowedCron.ok,
      `HTTP ${allowedCron.status}`,
    );
    const cronBody = (await allowedCron.json().catch(() => null)) as {
      sourceJobs?: { claimed?: unknown };
      refundJobs?: { claimed?: unknown };
    } | null;
    check(
      "استجابة المهمة تعرض عدادات العاملين الدائمين",
      typeof cronBody?.sourceJobs?.claimed === "number" &&
        typeof cronBody?.refundJobs?.claimed === "number",
    );
  }

  // -------------------------------------------------------------------
  section("دخول المسؤول والوصول المصرّح");

  const adminEmail = process.env.VERIFY_ADMIN_EMAIL?.trim();
  const adminPassword = process.env.VERIFY_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    skip(
      "اختبار دخول المسؤول",
      "اختياري؛ اضبط VERIFY_ADMIN_EMAIL وVERIFY_ADMIN_PASSWORD وVERIFY_ADMIN_TOTP_CODE مؤقتًا",
    );
  } else {
    const cookies = new Map<string, string>();
    try {
      const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      });
      mergeResponseCookies(cookies, login);
      const loginBody = (await login.clone().json().catch(() => null)) as {
        twoFactorRedirect?: unknown;
      } | null;
      let authenticated = login.ok;

      if (login.ok && loginBody?.twoFactorRedirect === true) {
        const totpCode = process.env.VERIFY_ADMIN_TOTP_CODE ?? "";
        if (!/^\d{6}$/u.test(totpCode)) {
          check(
            "رمز TOTP مؤقت مضبوط لاختبار المسؤول",
            false,
            "اضبط VERIFY_ADMIN_TOTP_CODE بستة أرقام وقت التشغيل فقط",
          );
          authenticated = false;
        } else {
          const secondFactor = await fetch(
            `${BASE}/api/auth/two-factor/verify-totp`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: BASE,
                Cookie: cookieHeader(cookies),
              },
              body: JSON.stringify({ code: totpCode, trustDevice: false }),
            },
          );
          mergeResponseCookies(cookies, secondFactor);
          check(
            "العامل الثاني للمسؤول ينجح",
            secondFactor.ok,
            `HTTP ${secondFactor.status}`,
          );
          authenticated = secondFactor.ok;
        }
      } else {
        check("تسجيل الدخول ينجح", login.ok, `HTTP ${login.status}`);
      }

      if (authenticated && cookies.size > 0) {
        if (resetQueryTrace()) {
          const authenticatedHome = await fetch(`${BASE}/`, {
            headers: { Cookie: cookieHeader(cookies) },
          });
          await authenticatedHome.arrayBuffer();
          const authenticatedTrace = readQueryTrace();
          const expectedWrites = authenticatedTrace.filter(
            (entry) =>
              entry.verb === "INSERT" && entry.targets.includes("AeApiLog"),
          ).length;
          const unexpectedWrites = authenticatedTrace.filter(
            (entry) =>
              ["INSERT", "UPDATE", "DELETE"].includes(entry.verb) &&
              !entry.targets.includes("AeApiLog"),
          );
          check(
            "الصفحة الرئيسية تعمل بجلسة موثقة",
            authenticatedHome.ok,
            `HTTP ${authenticatedHome.status}`,
          );
          check(
            "صفحة المستخدم المسجل لا تتجاوز خمس Queries",
            authenticatedTrace.length <= 5,
            String(authenticatedTrace.length),
          );
          check(
            "الجلسة لا تضيف كتابة غير سجلّي المورد",
            expectedWrites === 2 && unexpectedWrites.length === 0,
            `${expectedWrites} expected / ${unexpectedWrites.length} unexpected`,
          );
        }

        const adminOk = await fetch(`${BASE}/api/admin/orders`, {
          headers: { Cookie: cookieHeader(cookies) },
        });
        check(
          "المسؤول يصل إلى بياناته",
          adminOk.ok,
          `HTTP ${adminOk.status}`,
        );

        if (adminOk.ok) {
          const payload = (await adminOk.json()) as {
            rows: unknown[];
            stats: { totalOrders: number };
          };
          check(
            "الاستجابة تحمل الصفوف والإحصاءات",
            Array.isArray(payload.rows) &&
              typeof payload.stats?.totalOrders === "number",
          );
        }
      }
    } finally {
      // لا نترك جلسة تحقق صالحة على الحساب الحقيقي.
      if (cookies.size > 0) {
        await fetch(`${BASE}/api/auth/sign-out`, {
          method: "POST",
          headers: { Cookie: cookieHeader(cookies), Origin: BASE },
        }).catch(() => undefined);
      }
    }
  }

  console.log(`\n${"═".repeat(58)}`);
  console.log(`  نجح: ${passed}   |   فشل: ${failed}   |   تخطّى: ${skipped}`);
  console.log(`${"═".repeat(58)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(
    "\n✗ فشل التحقق — تأكّد أن الخادم يعمل:",
    safeErrorKind(e),
  );
  process.exit(1);
});
