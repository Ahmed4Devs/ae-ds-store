import { env } from "@/lib/env";
import { AeApiError, normalizeAeErrorCode } from "./errors";
import { currentTimestamp, signRequest } from "./signature";
import { getMockResponse } from "./mock-data";
import { getAccessToken, refreshAccessToken } from "./token";

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

/**
 * الحقول التي لا يجوز تسجيلها أبدًا: أسرار المنصة + بيانات العميل الشخصية.
 * بيانات الطلبية (الاسم والجوال والعنوان) تصل متداخلة داخل سلاسل JSON
 * (مثل param_place_order_request…)، لذا يجب حجبها بعمق لا على السطح فقط.
 */
// أسماء مفاتيح تُحجَب حرفيًا (مطابقة غير حسّاسة لحالة الأحرف)
const REDACTED_EXACT = new Set([
  // أسرار المنصة
  "sign",
  "app_key",
  "appkey",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "app_secret",
  "client_secret",
  "private_key",
  "privatekey",
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passphrase",
  // أسماء أشخاص وحقول عنوان لا تحمل جذرًا مميّزًا
  "full_name",
  "fullname",
  "first_name",
  "last_name",
  "given_name",
  "family_name",
  "middle_name",
  "surname",
  "receiver_name",
  "buyer_name",
  "sender_name",
  "contact_name",
  "contact_person",
  "person",
  "zip",
  "city",
  "province",
  "district",
  "state",
  "street",
  "building",
  "neighborhood",
  // نصوص حرّة قد يكتب فيها العميل بيانات شخصية
  "keyword",
  "key_word",
  "memo",
  "order_memo",
  "remark",
  "remarks",
  "comment",
  "comments",
]);

// جذور تُحجَب أينما وردت داخل اسم المفتاح (تلتقط الأشكال المركّبة مثل
// receiver_address و send_mobile و buyer_email و detail_address). مقصورة
// على جذور لا تظهر في أسماء حقول غير حسّاسة (تجنّبنا "name" عمدًا لأنه يرد
// في logistics_service_name وغيره).
const REDACTED_SUBSTRINGS = [
  "mobile",
  "phone",
  "email",
  "addr", // address, address2, nat_addr, detail_address, addressLine…
  "postal",
  "passport",
  "cpf",
  "taxpayer",
  "id_card",
  "national",
  "secret",
  "token",
  "credential",
];

/**
 * استجابة المنصة غير موثوقة حتى لو نجح TLS. الحدّ مطبّق على البايتات بعد
 * فك ضغط HTTP لأن الاعتماد على Content-Length وحده لا يوقف قنبلة ضغط أو
 * استجابة chunked بلا طول مُعلن.
 */
const MAX_AE_RESPONSE_BYTES = 2 * 1024 * 1024;

class ResponseBodyTooLargeError extends Error {
  constructor() {
    super("AliExpress response body exceeded the configured safety limit");
    this.name = "ResponseBodyTooLargeError";
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes = MAX_AE_RESPONSE_BYTES,
): Promise<string> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      // إلغاء الجسم يمنع إبقاء اتصال كبير قيد التنزيل بعد اكتشاف تجاوزه.
      try {
        await response.body?.cancel();
      } catch {
        // الإلغاء مساعد؛ سنرفض الاستجابة سواء نجح أم لا.
      }
      throw new ResponseBodyTooLargeError();
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // لا نسمح لفشل الإلغاء بتحويل الرفض الأمني إلى نجاح.
        }
        throw new ResponseBodyTooLargeError();
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/** يحذف محارف التحكم ويحدّ النصوص القادمة من المزوّد قبل الخطأ أو السجل. */
function safeUpstreamText(value: unknown, maxLength: number): string | undefined {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return undefined;
  }

  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  if (REDACTED_EXACT.has(k)) return true;
  return REDACTED_SUBSTRINGS.some((s) => k.includes(s));
}

/**
 * حجب متكرّر: يمرّ على الكائنات والمصفوفات، ويحاول تحليل السلاسل التي
 * تبدو JSON ليحجب ما بداخلها ثم يعيد ترميزها. بهذا لا تنجو أي PII مهما
 * تعمّقت في الحمولة.
 */
function deepRedact(value: unknown): unknown {
  if (typeof value === "string") {
    const t = value.trim();
    const looksJson =
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"));
    if (looksJson) {
      try {
        return JSON.stringify(deepRedact(JSON.parse(t)));
      } catch {
        // ليست JSON صالحة — تُترك كما هي
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // نتجاهل __proto__ حتى لا يلوّث كائن الإخراج (تلوث النموذج الأولي)
      if (k === "__proto__") continue;
      out[k] = isSensitiveKey(k) ? "«محجوب»" : deepRedact(v);
    }
    return out;
  }
  return value;
}

export function redact(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return deepRedact(params) as Record<string, unknown>;
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
    const code = safeUpstreamText(
      errResp.code ?? errResp.type ?? errResp.msg,
      128,
    );
    if (code) {
      return { code, message: safeUpstreamText(errResp.msg, 500) };
    }
  }

  // رمز في الجذر — "0" يعني النجاح في هذه المنصة
  const rootCode = safeUpstreamText(p.code, 128);
  if (rootCode && rootCode !== "0" && rootCode !== "200") {
    return { code: rootCode, message: safeUpstreamText(p.msg, 500) };
  }

  // خطأ داخل result
  const result = p.result as Record<string, unknown> | undefined;
  if (result && typeof result === "object") {
    const ec = safeUpstreamText(result.error_code, 128);
    if (ec && ec !== "0") {
      return {
        code: ec,
        message: safeUpstreamText(result.error_msg, 500),
      };
    }

    /**
     * بعض الواجهات (حساب أجرة الشحن مثلًا) تضع النتيجة في `result.success`
     * و`result.code` (200 = نجاح) لا في `error_code`. تجاهلهما كان يجعل
     * فشلًا مثل DELIVERY_INFO_EMPTY يُسجَّل نجاحًا، فتُعاد قائمة شحن فارغة
     * وتظهر للعميل «تعذّر حساب الشحن» بلا أثر في السجلّ يُعين على التشخيص.
     */
    const success = result.success;
    const isFailure =
      success === false ||
      success === "false" ||
      (typeof result.code !== "undefined" &&
        String(result.code) !== "0" &&
        String(result.code) !== "200");
    if (isFailure) {
      const code = safeUpstreamText(
        result.error_code ?? result.code ?? result.msg,
        128,
      ) ?? "ResultError";
      return {
        code,
        message: safeUpstreamText(result.error_msg ?? result.msg, 500),
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
  /**
   * محاولة واحدة كاملة: تُبنى المُعاملات وتُوقَّع وتُرسَل.
   *
   * مستخلصة في دالة داخلية لأن إعادة المحاولة بعد تجديد التفويض **لا يصحّ
   * أن تعيد إرسال الحمولة نفسها**: الطابع الزمني ورمز الوصول كلاهما يدخل
   * في حساب التوقيع، فإعادة البناء شرط لا تحسين.
   */
  async function attempt(): Promise<AeCallResult<T>> {
    const startedAttempt = Date.now();

    // المُعاملات العامة كما ينص التوثيق
    const params: Record<string, unknown> = {
      // توضع معاملات الأعمال أولًا كي لا تستطيع أي إضافة مستقبلية تجاوز
      // هوية التطبيق أو الساعة أو خوارزمية التوقيع بقيمة قادمة من العميل.
      ...businessParams,
      app_key: cfg.AE_APP_KEY,
      timestamp: currentTimestamp(),
      sign_method: "sha256",
    };

    if (requiresAuth) {
      // الرمز يأتي من المخزن لا من البيئة: البيئة لا تُحدَّث في وقت التشغيل
      const token = await getAccessToken();
      if (!token) {
        throw new AeApiError({
          apiName,
          code: "IllegalAccessToken",
          message:
            "لا يوجد رمز وصول مخزَّن ولا في البيئة، وهذه الواجهة تتطلب تفويضًا وفق التوثيق.",
        });
      }
      params.access_token = token;
    }

    params.sign = signRequest(apiName, params, cfg.AE_APP_SECRET);

    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.append(k, String(v));
    }

    // واجهات الرموز تُسمّى بمسار يبدأ بشرطة مائلة (/auth/token/refresh)،
    // فتوليد الرابط بالوصل المباشر ينتج شرطتين ويردّ الخادم 404.
    const url = `${cfg.AE_API_BASE_URL.replace(/\/$/, "")}/${apiName.replace(/^\//, "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    /** يسجّل فشل صيغة/حجم الاستجابة مرة واحدة ثم يعيده بخطأ آمن. */
    async function rejectUnsafeResponse(message: string): Promise<never> {
      const failure = { code: "InternalError", message };
      await logCall({
        apiName,
        mode: "live",
        success: false,
        error: failure,
        durationMs: Date.now() - startedAttempt,
        params,
        orderId: options.orderId,
      });
      throw new AeApiError({ apiName, ...failure });
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body,
        signal: controller.signal,
        cache: "no-store",
        // A redirect could replay the credential-bearing form body to another
        // origin. AliExpress endpoints are fixed and must answer directly.
        redirect: "error",
      });

      const mediaType = res.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        mediaType !== "application/json" &&
        !mediaType?.endsWith("+json")
      ) {
        await res.body?.cancel().catch(() => undefined);
        await rejectUnsafeResponse(
          `أعادت AliExpress نوع محتوى غير صالح (HTTP ${res.status}).`,
        );
      }

      let text = "";
      try {
        text = await readBoundedResponseBody(res);
      } catch (e) {
        if (!(e instanceof ResponseBodyTooLargeError)) throw e;
        await rejectUnsafeResponse(
          `تجاوز جسم استجابة AliExpress الحد الآمن (HTTP ${res.status}).`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        // لا نضمّن مقتطفًا من الجسم: قد يكون HTML به أسرار، أو نصًا يحقن
        // أسطرًا مزوّرة في السجل، أو بيانات شخصية ارتدّت من طلبنا.
        await rejectUnsafeResponse(
          `أعادت AliExpress استجابة ليست JSON صالحة (HTTP ${res.status}).`,
        );
      }

      const durationMs = Date.now() - startedAttempt;
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

      // نجاح بنيوي داخل JSON لا يلغي فشل طبقة HTTP. قبول 4xx/5xx بلا
      // error_response كان يسجّل الاستدعاء نجاحًا ويمرّر كائنًا ناقصًا.
      if (!res.ok) {
        await rejectUnsafeResponse(
          `أعادت AliExpress حالة HTTP ${res.status} بلا خطأ مهيكل.`,
        );
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
      const durationMs = Date.now() - startedAttempt;
      const isAbort = e instanceof Error && e.name === "AbortError";
      const wrapped = new AeApiError({
        apiName,
        code: isAbort ? "isp.service-unavailable" : "InternalError",
        message: isAbort
          ? "انتهت مهلة الاتصال بمنصة AliExpress."
          : "فشل الاتصال بمنصة AliExpress.",
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

  try {
    return await attempt();
  } catch (e) {
    /**
     * إعادة محاولة واحدة عند خطأ تفويض — ولا أكثر.
     *
     * السبب في وجودها: انتهاء رمز الوصول بين استدعاءين أمر طبيعي لا عطل،
     * وكان يظهر للعميل كفشل توريد يحتاج تدخّلًا يدويًا.
     *
     * والسبب في تحديدها بواحدة: خطأ التفويض المتكرّر معناه أن التفويض نفسه
     * ساقط (انتهى رمز التجديد، أو سُحبت صلاحية التطبيق)، والدوران عليه
     * يستنزف حصة الاستدعاءات ويعرّض مفتاح التطبيق للحجب. الفشل السريع
     * هنا أنفع من محاولة لا تنجح.
     */
    if (
      !(e instanceof AeApiError) ||
      e.errorClass !== "AUTH" ||
      !requiresAuth ||
      // واجهة التجديد نفسها لا تُعاد: فشلها هو نفسه سبب الفشل
      apiName === "/auth/token/refresh"
    ) {
      throw e;
    }

    const refreshed = await refreshAccessToken();
    if (!refreshed.ok) throw e;

    return attempt();
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
    const safeErrorCode = entry.error?.code
      ? normalizeAeErrorCode(entry.error.code)
      : undefined;
    // Never persist the provider's prose. A signed/TLS response can still
    // reflect a token or customer field; documented local wording is enough
    // for diagnosis while the normalized code preserves classification.
    const safeErrorMessage = safeErrorCode
      ? new AeApiError({ apiName: entry.apiName, code: safeErrorCode })
          .operatorMessage
      : undefined;
    await prisma.aeApiLog.create({
      data: {
        apiName: entry.apiName,
        mode: entry.mode,
        success: entry.success,
        errorCode: safeErrorCode ?? null,
        errorMessage: safeErrorMessage ?? null,
        retryable: safeErrorCode
          ? classifyErrorCode(safeErrorCode) === "RETRYABLE"
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
