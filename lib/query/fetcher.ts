/**
 * طبقة الجلب المشتركة لاستعلامات العميل.
 *
 * تُستخدم `fetch` الأصلية لا axios: الأولى مدمجة في المتصفّح وفي Node،
 * وتتكامل مع طبقة التخزين المؤقت في Next.js، ولا تُضيف حجمًا إلى الحزمة.
 * ما تقدّمه axios زيادةً (المهلة والاعتراض ورمي الخطأ تلقائيًا) مُغطّى
 * هنا في نحو عشرين سطرًا.
 */

/** خطأ يحمل رمز الحالة حتى تقرر سياسة إعادة المحاولة بناءً عليه. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_API_ERROR_BYTES = 16 * 1024;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

function safeErrorText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}

async function readLimitedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) throw new Error("INVALID_CONTENT_TYPE");

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) throw new Error("INVALID_CONTENT_LENGTH");
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("RESPONSE_TOO_LARGE");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("EMPTY_RESPONSE");

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("INVALID_ENCODING");
  }
  if (text === "") throw new Error("EMPTY_RESPONSE");
  return JSON.parse(text) as unknown;
}

export async function apiGet<T>(
  path: string,
  { signal, timeoutMs = 20_000 }: FetchOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // دمج إشارة الإلغاء القادمة من المكتبة مع مهلتنا الخاصة
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const res = await fetch(path, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      let code: string | undefined;
      let message = `HTTP ${res.status}`;
      try {
        const body = await readLimitedJson(res, MAX_API_ERROR_BYTES);
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          code = safeErrorText(record.error);
          message = safeErrorText(record.message) ?? code ?? message;
        }
      } catch {
        // جسم غير JSON أو أكبر من سقف الخطأ — نكتفي برمز الحالة
      }
      throw new ApiError(res.status, message, code);
    }

    try {
      return (await readLimitedJson(res, MAX_API_RESPONSE_BYTES)) as T;
    } catch {
      throw new ApiError(502, "Invalid API response", "INVALID_RESPONSE");
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** يبني سلسلة استعلام متجاهلًا القيم الفارغة. */
export function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
