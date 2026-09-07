import { createHmac } from "node:crypto";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { hasAdminAssuranceForHeaders } from "@/lib/admin-access";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Route Handlers واجهات عامة؛ لذلك يسبق Better Auth هنا حد مستقل لحجم
 * الجسم ونوعه وحقوله، ثم محدِّد ذري لكل بريد على المسارات الحساسة.
 */

const handlers = toNextJsHandler(auth.handler);
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const MAX_USER_AGENT_CHARS = 512;
const MAX_FORWARDING_HEADER_CHARS = 512;
const MAX_COOKIE_HEADER_CHARS = 16 * 1024;
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60_000;
const RATE_LIMIT_CAS_ATTEMPTS = 8;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
let lastRateLimitPruneAt = 0;

export const GET = handlers.GET;

const RULES: Record<string, { max: number; windowMs: number }> = {
  "/sign-in/email": { max: 10, windowMs: 15 * 60_000 },
  "/sign-up/email": { max: 5, windowMs: 60 * 60_000 },
  "/request-password-reset": { max: 5, windowMs: 60 * 60_000 },
  "/send-verification-email": { max: 5, windowMs: 60 * 60_000 },
};

const STRING_LIMITS = {
  email: 254,
  name: 100,
  phone: 32,
  password: 128,
  currentPassword: 128,
  newPassword: 128,
  token: 2048,
  callbackURL: 2048,
  redirectTo: 2048,
  code: 64,
  method: 16,
  issuer: 100,
} as const;

type AuthBody = Record<string, unknown>;
type ParsedBody =
  | { body: AuthBody | null; request: Request; response?: never }
  | { body?: never; request?: never; response: Response };

interface EmailRateLimitDecision {
  ok: boolean;
  retryAfter: number;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryAfter?: number,
): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);

  return NextResponse.json(
    { code, message },
    { status, headers },
  );
}

async function readLimitedText(request: Request): Promise<string | Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return errorResponse(400, "INVALID_BODY", "Invalid Content-Length.");
    }
    if (bytes > MAX_AUTH_BODY_BYTES) {
      return errorResponse(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AUTH_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return errorResponse(413, "BODY_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return errorResponse(400, "INVALID_BODY", "Request body could not be read.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return errorResponse(400, "INVALID_BODY", "Request body is not valid UTF-8.");
  }
}

function rebuildJsonRequest(
  request: Request,
  body: AuthBody | null,
): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Request(request.url, {
    method: request.method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: request.signal,
  });
}

/**
 * التطبيق لا يدعم trusted-device. حذف الكوكي من النسخة التي تصل إلى Better
 * Auth يمنع حتى سجل قديم أُنشئ قبل هذه السياسة من تجاوز تحدّي TOTP. لا
 * نطابق القيمة أو نفكها؛ اسم الكوكي ثابت ومملوك للخادم.
 */
function stripDisabledTrustedDeviceCookie(
  request: Request,
  body: AuthBody | null,
): Request {
  const rawCookie = request.headers.get("cookie");
  if (!rawCookie) return request;

  const keptCookies = rawCookie.split(";").filter((part) => {
    const separator = part.indexOf("=");
    const name = (separator >= 0 ? part.slice(0, separator) : part).trim();
    return (
      name !== "ae_ds.trust_device" &&
      name !== "__Secure-ae_ds.trust_device"
    );
  });
  if (keptCookies.length === rawCookie.split(";").length) return request;

  const headers = new Headers(request.headers);
  if (keptCookies.length === 0) headers.delete("cookie");
  else headers.set("cookie", keptCookies.join(";"));

  return new Request(request.url, {
    method: request.method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: request.signal,
  });
}

async function parseAndValidateBody(request: Request): Promise<ParsedBody> {
  if (request.body === null) return { body: null, request };

  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return {
      response: errorResponse(
        415,
        "UNSUPPORTED_CONTENT_ENCODING",
        "Compressed authentication request bodies are not accepted.",
      ),
    };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    // التطبيق لا يملك مزوّدي OAuth ويستخدم عميل Better Auth الذي يرسل JSON.
    // رفض form-urlencoded يزيل اختلاف أول/آخر email عند تكرار الحقل، ويمنع
    // النماذج البسيطة العابرة للمواقع من الوصول إلى نقطة الاعتماد.
    return {
      response: errorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Authentication requests must use application/json.",
      ),
    };
  }

  const text = await readLimitedText(request);
  if (text instanceof Response) return { response: text };
  if (text === "") {
    return { body: null, request: rebuildJsonRequest(request, null) };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      response: errorResponse(400, "INVALID_JSON", "Request body is not valid JSON."),
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      response: errorResponse(400, "INVALID_BODY", "Request body must be an object."),
    };
  }

  const body = value as AuthBody;
  for (const [field, max] of Object.entries(STRING_LIMITS)) {
    const fieldValue = body[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== "string" || fieldValue.length > max) {
      return {
        response: errorResponse(
          400,
          "INVALID_FIELD",
          `Field ${field} must be a string of at most ${max} characters.`,
        ),
      };
    }
  }

  if (typeof body.email === "string" && body.email !== body.email.trim()) {
    return {
      response: errorResponse(400, "INVALID_EMAIL", "Email must not contain outer whitespace."),
    };
  }
  if (typeof body.name === "string") {
    const trimmedName = body.name.trim();
    if (body.name !== trimmedName || trimmedName.length < 2) {
      return {
        response: errorResponse(
          400,
          "INVALID_NAME",
          "Name must contain at least two characters and no outer whitespace.",
        ),
      };
    }
  }

  // مرّر نسخة معيارية من الجسم الذي فُحص فعلًا. هذا يمنع اختلاف المُحلّل
  // أو ترتيب حقول email المكررة بين المحدِّد وBetter Auth، ولا يعيد قراءة
  // stream غير محدود بعد أن تحقّقنا من حجمه.
  return { body, request: rebuildJsonRequest(request, body) };
}

function authPath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const marker = "/api/auth";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return "/";
  const suffix = pathname.slice(markerIndex + marker.length) || "/";
  return suffix.length > 1 ? suffix.replace(/\/+$/, "") : suffix;
}

/**
 * سياسة التطبيق فوق مخططات Better Auth العامة: هذا المتجر يدعم TOTP فقط،
 * ولا يسمح بتجاوز العامل الثاني عبر trusted-device. كما نثبّت issuer من
 * الخادم حتى لا يستطيع طلب مباشر زرع اسم مضلل في تطبيق المصادقة.
 */
async function validateTwoFactorPolicy(
  path: string,
  body: AuthBody | null,
  requestHeaders: Headers,
): Promise<Response | null> {
  if (!path.startsWith("/two-factor/")) return null;
  if (!body) {
    return errorResponse(400, "INVALID_BODY", "A JSON object is required.");
  }

  if (body.trustDevice !== undefined && body.trustDevice !== false) {
    return errorResponse(
      400,
      "TRUSTED_DEVICE_DISABLED",
      "Trusted devices are disabled for this application.",
    );
  }
  if (body.disableSession !== undefined && body.disableSession !== false) {
    return errorResponse(
      400,
      "INVALID_FIELD",
      "Successful second-factor verification must create a session.",
    );
  }

  if (path === "/two-factor/enable") {
    if (body.method !== undefined && body.method !== "totp") {
      return errorResponse(
        400,
        "UNSUPPORTED_TWO_FACTOR_METHOD",
        "Only TOTP is supported.",
      );
    }
    if (body.issuer !== undefined) {
      return errorResponse(
        400,
        "INVALID_FIELD",
        "The TOTP issuer is configured by the server.",
      );
    }
  }

  if (
    path === "/two-factor/send-otp" ||
    path === "/two-factor/verify-otp"
  ) {
    return errorResponse(
      404,
      "TWO_FACTOR_METHOD_NOT_FOUND",
      "This two-factor method is not available.",
    );
  }

  // لا يحتاج المتجر إلى كشف سر TOTP القديم أو تعطيل العامل من جلسة ويب.
  // الاسترداد الإداري الموثق موضح في SECURITY.md ويُلغي كل الجلسات.
  if (
    path === "/two-factor/get-totp-uri" ||
    path === "/two-factor/disable"
  ) {
    return errorResponse(
      404,
      "TWO_FACTOR_OPERATION_NOT_AVAILABLE",
      "This two-factor operation is not available.",
    );
  }

  // إعادة رموز الاسترداد تكشف أسرارًا صريحة وتبطل القديمة، لذلك لا تكفي
  // كلمة المرور مع أي جلسة: يلزم مسؤول وجلسة موثقة بالعامل الثاني نفسه.
  if (
    path === "/two-factor/generate-backup-codes" &&
    !(await hasAdminAssuranceForHeaders(requestHeaders))
  ) {
    return errorResponse(
      403,
      "SECOND_FACTOR_REQUIRED",
      "A verified administrator session is required.",
    );
  }

  if (
    path === "/two-factor/verify-totp" &&
    (typeof body.code !== "string" || !/^\d{6}$/u.test(body.code))
  ) {
    return errorResponse(
      400,
      "INVALID_CODE",
      "The authenticator code must contain six digits.",
    );
  }

  if (
    path === "/two-factor/verify-backup-code" &&
    (typeof body.code !== "string" ||
      !/^[A-Za-z0-9]{5}-[A-Za-z0-9]{7}$/u.test(body.code))
  ) {
    return errorResponse(
      400,
      "INVALID_CODE",
      "The recovery code format is invalid.",
    );
  }

  return null;
}

function rateLimitKey(path: string, email: string | null): string {
  // لا نحتفظ بالبريد الصريح في PostgreSQL أو في أي لقطة تشخيصية. بادئة
  // مستقلة تمنع التصادم مع مفاتيح Better Auth المبنية على IP في الجدول نفسه.
  const digest = createHmac("sha256", env().BETTER_AUTH_SECRET)
    .update(`${path}\0${email ?? "<missing>"}`)
    .digest("base64url");
  return `auth-email:v1:${digest}`;
}

async function maybePruneRateLimits(now: number): Promise<void> {
  if (now - lastRateLimitPruneAt < 5 * 60_000) return;
  lastRateLimitPruneAt = now;

  try {
    const cutoff = BigInt(now - RATE_LIMIT_RETENTION_MS);
    const stale = await prisma.rateLimit.findMany({
      where: { lastRequest: { lt: cutoff } },
      orderBy: { lastRequest: "asc" },
      take: 1_000,
      select: { id: true },
    });
    await prisma.rateLimit.deleteMany({
      where: {
        id: { in: stale.map((row) => row.id) },
        lastRequest: { lt: cutoff },
      },
    });
  } catch {
    // التنظيف تحسين للسعة وليس جزءًا من قرار السماح؛ يعاد لاحقًا بلا تسريب
    // تفاصيل اتصال قاعدة البيانات إلى سجل عام أو إلى الاستجابة.
    lastRateLimitPruneAt = 0;
  }
}

/**
 * يستهلك محاولة من نافذة منزلقة مشتركة بين كل نسخ الخادم.
 *
 * updateMany مع شروط count/lastRequest هو compare-and-swap ذري في PostgreSQL:
 * لا تستطيع دفعة طلبات متوازية تجاوز max، ومن يخسر سباق الإنشاء/إعادة الضبط
 * يعيد القراءة بدل السماح اعتمادًا على لقطة قديمة.
 */
async function consumeEmailRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<EmailRateLimitDecision> {
  for (let attempt = 0; attempt < RATE_LIMIT_CAS_ATTEMPTS; attempt++) {
    const now = Date.now();
    const nowBigInt = BigInt(now);
    const cutoff = BigInt(now - windowMs);

    const incremented = await prisma.rateLimit.updateMany({
      where: {
        key,
        lastRequest: { gt: cutoff },
        count: { lt: max },
      },
      data: {
        count: { increment: 1 },
        lastRequest: nowBigInt,
      },
    });
    if (incremented.count === 1) {
      await maybePruneRateLimits(now);
      return { ok: true, retryAfter: 0 };
    }

    const current = await prisma.rateLimit.findUnique({
      where: { key },
      select: { count: true, lastRequest: true },
    });

    if (!current) {
      const created = await prisma.rateLimit.createMany({
        data: [{ key, count: 1, lastRequest: nowBigInt }],
        skipDuplicates: true,
      });
      if (created.count === 1) {
        await maybePruneRateLimits(now);
        return { ok: true, retryAfter: 0 };
      }
      // أنشأ طلب منافس المفتاح نفسه؛ اقرأ حالته في الدورة التالية.
      continue;
    }

    if (current.lastRequest <= cutoff) {
      const reset = await prisma.rateLimit.updateMany({
        where: { key, lastRequest: { lte: cutoff } },
        data: { count: 1, lastRequest: nowBigInt },
      });
      if (reset.count === 1) {
        await maybePruneRateLimits(now);
        return { ok: true, retryAfter: 0 };
      }
      continue;
    }

    if (current.count >= max) {
      const remainingMs = current.lastRequest + BigInt(windowMs) - nowBigInt;
      const retryAfter = Number(
        (remainingMs + BigInt(999)) / BigInt(1000),
      );
      return { ok: false, retryAfter: Math.max(1, retryAfter) };
    }
  }

  // التنافس غير المعتاد لا يتحول إلى fail-open.
  throw new Error("AUTH_RATE_LIMIT_CONTENTION");
}

export async function POST(request: Request): Promise<Response> {
  const userAgent = request.headers.get("user-agent");
  const cookieHeader = request.headers.get("cookie");
  const forwardingHeader = request.headers.get(
    process.env.VERCEL === "1" ? "x-vercel-forwarded-for" : "x-forwarded-for",
  );
  if (
    (userAgent !== null &&
      (userAgent.length > MAX_USER_AGENT_CHARS ||
        /[\u0000-\u001f\u007f]/u.test(userAgent))) ||
    (cookieHeader !== null && cookieHeader.length > MAX_COOKIE_HEADER_CHARS) ||
    (forwardingHeader !== null &&
      (forwardingHeader.length > MAX_FORWARDING_HEADER_CHARS ||
        /[\u0000-\u001f\u007f]/u.test(forwardingHeader)))
  ) {
    // Better Auth يحفظ User-Agent وIP في جدول الجلسة. رفض الترويسة الشاذة
    // يمنع تحويل طلب صغير إلى صف ضخم أو محارف تحكم في أدوات الإدارة/السجل.
    return errorResponse(431, "REQUEST_HEADERS_TOO_LARGE", "Request headers are invalid.");
  }

  const parsed = await parseAndValidateBody(request);
  if (parsed.response) return parsed.response;

  const path = authPath(request);
  const twoFactorPolicyResponse = await validateTwoFactorPolicy(
    path,
    parsed.body,
    parsed.request.headers,
  );
  if (twoFactorPolicyResponse) return twoFactorPolicyResponse;

  const rule = RULES[path];
  let consumedKey: string | null = null;
  if (rule) {
    const rawEmail = parsed.body?.email;
    const email =
      typeof rawEmail === "string" && rawEmail.length > 0
        ? rawEmail.toLowerCase()
        : null;

    if (!email) {
      return errorResponse(400, "INVALID_EMAIL", "A valid email is required.");
    }

    consumedKey = rateLimitKey(path, email);
    let decision: EmailRateLimitDecision;
    try {
      decision = await consumeEmailRateLimit(
        consumedKey,
        rule.max,
        rule.windowMs,
      );
    } catch {
      // المصادقة عملية حساسة: تعطل المخزن المشترك يفشل مغلقًا بدل إسقاط
      // الحماية والعودة إلى عداد محلي قابل للتجاوز أفقيًا.
      return errorResponse(
        503,
        "AUTH_TEMPORARILY_UNAVAILABLE",
        "Authentication is temporarily unavailable. Please try again later.",
        30,
      );
    }

    if (!decision.ok) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "Too many attempts. Please try again later.",
        decision.retryAfter,
      );
    }
  }

  const sanitizedRequest = stripDisabledTrustedDeviceCookie(
    parsed.request,
    parsed.body,
  );
  const response = await handlers.POST(sanitizedRequest);

  // نجاح الدخول يزيل عداد البريد حتى لا يعاقب صاحبه على إخفاقات سابقة.
  // فشل التنظيف لا يحوّل تسجيل دخول ناجح إلى خطأ ولا يفتح الحد نفسه.
  if (path === "/sign-in/email" && response.ok && consumedKey) {
    await prisma.rateLimit.deleteMany({ where: { key: consumedKey } }).catch(
      () => undefined,
    );
  }

  return response;
}
