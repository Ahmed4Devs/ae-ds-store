import { env } from "@/lib/env";
import { AeApiError } from "./errors";
import { currentTimestamp, signRequest } from "./signature";
import { getMockResponse } from "./mock-data";

/**
 * ناقل الطلبات إلى منصة AliExpress المفتوحة.
 *
 * يعمل بوضعين تحكمهما AE_MODE:
 *   mock — بيانات وهمية مطابقة لبنية استجابات التوثيق (لا مفاتيح مطلوبة)
 *   live — استدعاء حقيقي موقّع بـ HMAC-SHA256
 *
 * الوضعان يمرّان بالمسار نفسه (التحقق، تصنيف الأخطاء، السجل)،
 * حتى لا يفاجئك التبديل إلى live بسلوك مختلف.
 */

export interface AeCallOptions {
  /** هل تتطلب الواجهة access_token؟ راجع فحص authType في التوثيق. */
  requiresAuth?: boolean;
  /** مهلة الطلب بالمللي ثانية */
  timeoutMs?: number;
  /** مرجع طلبية متجرنا لأغراض السجل */
  orderId?: string;
}

export interface AeCallResult<T> {
  data: T;
  mode: "mock" | "live";
  durationMs: number;
}

/** الحقول التي لا يجوز تسجيلها أبدًا. */
const REDACTED_KEYS = new Set([
  "sign",
  "access_token",
  "refresh_token",
  "app_secret",
]);

function redact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = REDACTED_KEYS.has(k) ? "«محجوب»" : v;
  }
  return out;
}

/**
 * يستخرج رمز الخطأ من استجابة المنصة.
 * المنصة غير متسقة: أحيانًا `error_code` داخل result، وأحيانًا `code`
 * في الجذر، وأحيانًا `error_response.code`.
 */
function extractError(payload: unknown): { code: string; message?: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  // صيغة خطأ البوابة
  const errResp = p.error_response as Record<string, unknown> | undefined;
  if (errResp && typeof errResp === "object") {
    const code = errResp.code ?? errResp.type ?? errResp.msg;
    if (code) {
      return { code: String(code), message: String(errResp.msg ?? "") };
    }
  }

  // رمز في الجذر — "0" يعني النجاح في هذه المنصة
  if (typeof p.code === "string" && p.code !== "0" && p.code !== "200") {
    return { code: p.code, message: typeof p.msg === "string" ? p.msg : undefined };
  }

  // خطأ داخل result
  const result = p.result as Record<string, unknown> | undefined;
  if (result && typeof result === "object") {
    const ec = result.error_code;
    if (ec && String(ec) !== "0") {
      return {
        code: String(ec),
        message: typeof result.error_msg === "string" ? result.error_msg : undefined,
      };
    }
  }

  return null;
}

/**
 * ينفّذ استدعاءً لواجهة AliExpress.
 *
 * @param apiName اسم الواجهة كما في التوثيق، مثل `aliexpress.ds.product.get`
 * @param businessParams مُعاملات الأعمال (بدون المُعاملات العامة)
 */
export async function callAe<T = unknown>(
  apiName: string,
  businessParams: Record<string, unknown> = {},
  options: AeCallOptions = {},
): Promise<AeCallResult<T>> {
  const cfg = env();
  const started = Date.now();
  const { requiresAuth = true, timeoutMs = 20_000 } = options;

  // ---------------------------------------------------------------- mock
  if (cfg.AE_MODE === "mock") {
    const data = await getMockResponse<T>(apiName, businessParams);
    const durationMs = Date.now() - started;

    const err = extractError(data);
    if (err) {
      await logCall({
        apiName,
        mode: "mock",
        success: false,
        error: err,
        durationMs,
        params: businessParams,
        orderId: options.orderId,
      });
      throw new AeApiError({ apiName, code: err.code, message: err.message });
    }

    await logCall({
      apiName,
      mode: "mock",
      success: true,
      durationMs,
      params: businessParams,
      orderId: options.orderId,
    });
    return { data, mode: "mock", durationMs };
  }

  // ---------------------------------------------------------------- live
  if (requiresAuth && !cfg.AE_ACCESS_TOKEN) {
    throw new AeApiError({
      apiName,
      code: "IllegalAccessToken",
      message:
        "AE_ACCESS_TOKEN غير مضبوط، وهذه الواجهة تتطلب تفويضًا وفق التوثيق.",
    });
  }

  // المُعاملات العامة كما ينص التوثيق
  const params: Record<string, unknown> = {
    app_key: cfg.AE_APP_KEY,
    timestamp: currentTimestamp(),
    sign_method: "sha256",
    ...businessParams,
  };
  if (requiresAuth) {
    params.access_token = cfg.AE_ACCESS_TOKEN;
  }

  params.sign = signRequest(apiName, params, cfg.AE_APP_SECRET);

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.append(k, String(v));
  }

  const url = `${cfg.AE_API_BASE_URL.replace(/\/$/, "")}/${apiName}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AeApiError({
        apiName,
        code: "InternalError",
        message: `استجابة غير صالحة (HTTP ${res.status}): ${text.slice(0, 200)}`,
      });
    }

    const durationMs = Date.now() - started;
    const err = extractError(payload);

    if (err) {
      await logCall({
        apiName,
        mode: "live",
        success: false,
        error: err,
        durationMs,
        params,
        orderId: options.orderId,
      });
      throw new AeApiError({ apiName, code: err.code, message: err.message });
    }

    await logCall({
      apiName,
      mode: "live",
      success: true,
      durationMs,
      params,
      orderId: options.orderId,
    });
    return { data: payload as T, mode: "live", durationMs };
  } catch (e) {
    if (e instanceof AeApiError) throw e;
    const durationMs = Date.now() - started;
    const isAbort = e instanceof Error && e.name === "AbortError";
    const wrapped = new AeApiError({
      apiName,
      code: isAbort ? "isp.service-unavailable" : "InternalError",
      message: e instanceof Error ? e.message : String(e),
    });
    await logCall({
      apiName,
      mode: "live",
      success: false,
      error: { code: wrapped.code, message: wrapped.message },
      durationMs,
      params,
      orderId: options.orderId,
    });
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * يسجّل الاستدعاء في قاعدة البيانات.
 * الاستيراد ديناميكي حتى لا تعتمد طبقة التكامل على Prisma وقت الاختبار،
 * وأي فشل في التسجيل لا يُسقط الطلب الأصلي.
 */
async function logCall(entry: {
  apiName: string;
  mode: "mock" | "live";
  success: boolean;
  durationMs: number;
  params: Record<string, unknown>;
  error?: { code: string; message?: string };
  orderId?: string;
}): Promise<void> {
  try {
    const { prisma } = await import("@/lib/db");
    const { classifyErrorCode } = await import("./errors");
    await prisma.aeApiLog.create({
      data: {
        apiName: entry.apiName,
        mode: entry.mode,
        success: entry.success,
        errorCode: entry.error?.code ?? null,
        errorMessage: entry.error?.message?.slice(0, 500) ?? null,
        retryable: entry.error
          ? classifyErrorCode(entry.error.code) === "RETRYABLE"
          : null,
        durationMs: entry.durationMs,
        orderId: entry.orderId ?? null,
        requestSummary: redact(entry.params) as object,
      },
    });
  } catch {
    // التسجيل مساعد لا حرج — لا نُسقط الطلب بسببه
  }
}
