import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import {
  RESET_TOKEN_COOKIE,
  RESET_TOKEN_COOKIE_MAX_AGE,
  RESET_TOKEN_COOKIE_PATH,
  isResetToken,
} from "@/lib/reset-password-security";

/** hash لسكربت المظهر الثابت؛ أما سكربتات Next فتأخذ nonce تلقائيًا. */
const THEME_SCRIPT_HASH =
  "'sha256-jJAD2U1C04nCKhNDqkMbjIFbTrC0Ujpxnskc2bQGzlk='";

const MINUTE = 60_000;
const MAX_BUFFERED_BODY_BYTES = 512 * 1024;
const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;
const AUTH_BODY_LIMIT_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;
const AE_UPSTREAM_BUDGET = 100;

/** تحقق IP خالص يعمل في Proxy/Edge بلا استيراد node:net داخل حزمة المتصفح. */
function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  if (
    !value.includes(":") ||
    value.includes("%") ||
    !/^[0-9a-f:.]+$/iu.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  } catch {
    return false;
  }
}

interface LimitRule {
  group: string;
  max: number;
  windowMs: number;
  /** وحدات الكلفة؛ صفحات السلة تضخّم طلبًا واحدًا إلى استدعاءات مزوّد عدة. */
  cost?: number;
}

const AUTH_RULES: Readonly<Record<string, LimitRule>> = {
  "/api/auth/sign-in/email": {
    group: "auth-sign-in",
    max: 20,
    windowMs: 5 * MINUTE,
  },
  "/api/auth/sign-up/email": {
    group: "auth-sign-up",
    max: 10,
    windowMs: 15 * MINUTE,
  },
  "/api/auth/request-password-reset": {
    group: "auth-reset-request",
    max: 10,
    windowMs: 15 * MINUTE,
  },
  "/api/auth/reset-password": {
    group: "auth-reset",
    max: 10,
    windowMs: 15 * MINUTE,
  },
  "/api/auth/send-verification-email": {
    group: "auth-verification",
    max: 10,
    windowMs: 15 * MINUTE,
  },
};

/**
 * Vercel تضبط x-vercel-forwarded-for عند حدودها. وفي الاستضافة الذاتية لا
 * نقرأ X-Forwarded-For إلا عندما يعلن المشغّل وجود بروكسي موثوق، ونشترط أن
 * يستبدل البروكسي الترويسة بقيمة واحدة. لا يوفّر NextRequest عنوان المقبس
 * للتحقق من آخر hop؛ لذلك لا نخمّن ولا نثق بسلسلة متعددة العناصر.
 *
 * null تعني أن العنوان غير منسوب بثقة. عندئذ يفشل المحدد المحلي مفتوحًا
 * ويُترك الحدّ لـ WAF/البروكسي، بدل سلّة "unknown" مشتركة يستطيع مهاجم واحد
 * ملؤها وحجب جميع الزوار الشرعيين.
 */
export function trustedClientKey(req: NextRequest): string | null {
  if (process.env.VERCEL === "1") {
    const raw = req.headers.get("x-vercel-forwarded-for") ?? "";
    const candidate = raw.trim();
    return !candidate.includes(",") && isIpLiteral(candidate)
      ? `vercel:${candidate}`
      : null;
  }

  const trustedProxies = (process.env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (trustedProxies.length === 0) return null;

  const forwarded = (req.headers.get("x-forwarded-for") ?? "").trim();
  return !forwarded.includes(",") && isIpLiteral(forwarded)
    ? `proxy:${forwarded}`
    : null;
}

function contentSecurityPolicy(nonce: string): string {
  const isProduction = process.env.NODE_ENV === "production";
  const devEval = isProduction ? "" : " 'unsafe-eval'";
  const styleSrc = isProduction
    ? `style-src 'self' 'nonce-${nonce}'`
    : `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`;
  const styleAttrs = isProduction
    ? "style-src-attr 'none'"
    : "style-src-attr 'unsafe-inline'";
  const upgrade = isProduction ? "; upgrade-insecure-requests" : "";

  return (
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' ${THEME_SCRIPT_HASH} 'strict-dynamic'${devEval}`,
      "script-src-attr 'none'",
      styleSrc,
      styleAttrs,
      "img-src 'self' https: blob: data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'self'",
      "frame-src 'none'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ") + upgrade
  );
}

function requestBodyLimit(path: string, req: NextRequest): number | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  if (path.startsWith("/api/auth/")) return AUTH_BODY_LIMIT_BYTES;
  if (path === "/api/payments/webhook") return MAX_BUFFERED_BODY_BYTES;
  if (path.startsWith("/api/") || req.headers.has("next-action")) {
    return DEFAULT_BODY_LIMIT_BYTES;
  }
  return null;
}

async function bodyError(
  req: NextRequest,
  limit: number | null,
): Promise<NextResponse | null> {
  if (limit === null) return null;

  // لا تحتاج أي نقطة نهاية في المشروع أجسامًا مضغوطة. رفضها يمنع جسمًا
  // صغيرًا على السلك يتمدد إلى حمولة ضخمة بعد فك الضغط.
  const contentEncoding = req.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return NextResponse.json(
      { error: "UNSUPPORTED_CONTENT_ENCODING" },
      { status: 415, headers: { "Cache-Control": "no-store" } },
    );
  }

  const raw = req.headers.get("content-length");
  if (raw !== null && !/^\d+$/.test(raw)) {
    return NextResponse.json(
      { error: "INVALID_CONTENT_LENGTH" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (raw !== null && Number(raw) > limit) {
    return NextResponse.json(
      { error: "PAYLOAD_TOO_LARGE" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Content-Length اختياري في HTTP/2 والطلبات chunked، لذلك لا يكفي فحص
  // الترويسة. نقرأ الدفق حتى limit+1؛ Proxy في Next يحتفظ تلقائيًا بنسخة
  // للمصيّر. clone() هنا قد ينتظر فرع tee غير المقروء ويعلق تحت backpressure.
  const reader = req.body?.getReader();
  if (!reader) return null;

  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new DOMException("Body read timed out", "TimeoutError")),
        BODY_READ_TIMEOUT_MS,
      );
    });

    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        return NextResponse.json(
          { error: "PAYLOAD_TOO_LARGE" },
          { status: 413, headers: { "Cache-Control": "no-store" } },
        );
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    const timedOut =
      error instanceof DOMException && error.name === "TimeoutError";
    return NextResponse.json(
      { error: timedOut ? "REQUEST_TIMEOUT" : "INVALID_BODY" },
      {
        status: timedOut ? 408 : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }

  return null;
}

function applyCsp(response: NextResponse, csp: string | null): NextResponse {
  if (csp) response.headers.set("Content-Security-Policy", csp);
  return response;
}

function pass(requestHeaders: Headers, csp: string | null): NextResponse {
  return applyCsp(
    NextResponse.next({ request: { headers: requestHeaders } }),
    csp,
  );
}

function limitOrPass(
  req: NextRequest,
  rule: LimitRule,
  requestHeaders: Headers,
  csp: string | null,
): NextResponse {
  const client = trustedClientKey(req);
  if (!client) return pass(requestHeaders, csp);

  const result = rateLimit(
    `${client}:${rule.group}`,
    rule.max,
    rule.windowMs,
    rule.cost,
  );
  const headers = {
    "X-RateLimit-Limit": String(rule.max),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };

  if (!result.ok) {
    return applyCsp(
      NextResponse.json(
        { error: "RATE_LIMITED" },
        {
          status: 429,
          headers: {
            ...headers,
            "Cache-Control": "no-store",
            "Retry-After": String(result.retryAfter),
          },
        },
      ),
      csp,
    );
  }

  const response = pass(requestHeaders, csp);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

function captureResetToken(
  req: NextRequest,
  csp: string | null,
): NextResponse | null {
  if (req.method !== "GET" || req.nextUrl.pathname !== "/reset-password") {
    return null;
  }

  const tokens = req.nextUrl.searchParams.getAll("token");
  if (tokens.length === 0) return null;

  const cleanUrl = req.nextUrl.clone();
  cleanUrl.search = "";
  const valid = tokens.length === 1 && isResetToken(tokens[0]);
  if (!valid) cleanUrl.searchParams.set("error", "INVALID_TOKEN");

  // NextResponse.redirect في Next.js 16 يتطلب URL مطلقًا. نبنيه من الأصل
  // المضبوط تشغيليًا لا من req.nextUrl/Host كي لا يتحول رابط الاستعادة إلى
  // open redirect عند وجود proxy يمرر Host أو X-Forwarded-Host غير موثوق.
  const configuredPublicUrl = new URL(
    process.env.STORE_PUBLIC_URL || "http://localhost:3000",
  );
  if (
    !["http:", "https:"].includes(configuredPublicUrl.protocol) ||
    configuredPublicUrl.username ||
    configuredPublicUrl.password
  ) {
    throw new TypeError("STORE_PUBLIC_URL must be a safe HTTP(S) origin");
  }
  const redirectUrl = new URL(
    `${cleanUrl.pathname}${cleanUrl.search}`,
    configuredPublicUrl.origin,
  );
  const response = applyCsp(
    NextResponse.redirect(redirectUrl, 303),
    csp,
  );
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");

  if (valid) {
    response.cookies.set(RESET_TOKEN_COOKIE, tokens[0], {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: RESET_TOKEN_COOKIE_PATH,
      maxAge: RESET_TOKEN_COOKIE_MAX_AGE,
    });
  } else {
    response.cookies.delete({
      name: RESET_TOKEN_COOKIE,
      path: RESET_TOKEN_COOKIE_PATH,
    });
  }

  return response;
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  const isDocumentRoute = !path.startsWith("/api/");
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = isDocumentRoute ? contentSecurityPolicy(nonce) : null;

  // لا نمرر قيمًا يختارها العميل إلى المصيّر على أنها nonce أو CSP موثوقة.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete("x-nonce");
  requestHeaders.delete("content-security-policy");
  if (csp) {
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", csp);
  }

  const resetRedirect = captureResetToken(req, csp);
  if (resetRedirect) return resetRedirect;

  const rejectedBody = await bodyError(req, requestBodyLimit(path, req));
  if (rejectedBody) return applyCsp(rejectedBody, csp);

  // إشعار الدفع يتحقق من توقيعه وحدّه، والمهمة المجدولة تقبل Bearer فقط.
  if (path === "/api/payments/webhook" || path.startsWith("/api/cron/")) {
    return pass(requestHeaders, csp);
  }

  // ترويسة next-action يختارها العميل؛ لا يجوز أن تُخرج مسار API من قاعدته.
  if (path.startsWith("/api/auth/")) {
    return limitOrPass(
      req,
      AUTH_RULES[path] ?? {
        group: "auth-general",
        max: 60,
        windowMs: MINUTE,
      },
      requestHeaders,
      csp,
    );
  }

  if (path.startsWith("/api/")) {
    const rule =
      path === "/api/shipping"
        ? {
            group: "ali-upstream",
            max: AE_UPSTREAM_BUDGET,
            windowMs: MINUTE,
          }
        : /^\/api\/orders\/AE-\d{8}-[0-9A-F]{6}\/tracking$/u.test(path)
          ? {
              group: "ali-upstream",
              max: AE_UPSTREAM_BUDGET,
              windowMs: MINUTE,
              cost: 20,
            }
          : { group: "api", max: 120, windowMs: MINUTE };
    return limitOrPass(req, rule, requestHeaders, csp);
  }

  if (req.headers.has("next-action")) {
    // هوية Server Action لا تُستنتج من pathname: يستطيع Next توجيه action
    // إلى worker آخر ولو أُرسلت إلى صفحة مختلفة. لذلك يُحاسَب كل action
    // بميزانية أثقل إجراء (checkout/import/retry)، فلا يتجاوز المهاجم حدها
    // بإرسال المعرّف نفسه إلى `/` أو أي صفحة أرخص.
    return limitOrPass(
      req,
      {
        group: "server-action-expensive",
        max: AE_UPSTREAM_BUDGET,
        windowMs: MINUTE,
        cost: 20,
      },
      requestHeaders,
      csp,
    );
  }

  if (path === "/search") {
    return limitOrPass(
      req,
      {
        group: "ali-upstream",
        max: AE_UPSTREAM_BUDGET,
        windowMs: MINUTE,
      },
      requestHeaders,
      csp,
    );
  }

  if (path === "/") {
    return limitOrPass(
      req,
      {
        group: "ali-upstream",
        max: AE_UPSTREAM_BUDGET,
        windowMs: MINUTE,
        // الصفحة الرئيسية تستدعي البحث والفئات معًا.
        cost: 2,
      },
      requestHeaders,
      csp,
    );
  }

  if (/^\/orders\/AE-\d{8}-[0-9A-F]{6}(?:\/invoice)?$/u.test(path)) {
    return limitOrPass(
      req,
      {
        group: "ali-upstream",
        max: AE_UPSTREAM_BUDGET,
        windowMs: MINUTE,
        cost: 20,
      },
      requestHeaders,
      csp,
    );
  }

  if (path.startsWith("/product/")) {
    return limitOrPass(
      req,
      {
        group: "ali-upstream",
        max: AE_UPSTREAM_BUDGET,
        windowMs: MINUTE,
        cost: 2,
      },
      requestHeaders,
      csp,
    );
  }

  if (path === "/cart" || path === "/checkout") {
    return limitOrPass(
      req,
      {
        group: "ali-upstream",
        max: AE_UPSTREAM_BUDGET,
        windowMs: MINUTE,
        // السلة القصوى 10 أسطر، ولكل سطر تفاصيل منتج وخيار شحن.
        cost: 20,
      },
      requestHeaders,
      csp,
    );
  }

  return pass(requestHeaders, csp);
}

export const config = {
  // يشمل Server Actions والصفحات وAPI، ويستثني أصول Next والميتا الثابتة.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
