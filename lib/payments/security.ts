import type { PaymentProviderName } from "./types";

/** حدّ يمنع استجابة مزوّد شاذّة من استهلاك ذاكرة الخادم بلا سقف. */
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

/** مهلة كل اتصال مالي صادر؛ لا يجوز أن تبقى دالة الدفع معلّقة بلا نهاية. */
export const PAYMENT_PROVIDER_TIMEOUT_MS = 12_000;

const CHECKOUT_HOST_SUFFIXES: Readonly<
  Record<Exclude<PaymentProviderName, "manual">, readonly string[]>
> = {
  moyasar: ["moyasar.com"],
  tap: ["tap.company", "gosell.io"],
};

/** يثبت أن القيمة اسم مزوّد نعرف قواعده، لا نصًّا قديمًا حرًّا من القاعدة. */
export function isPaymentProviderName(
  value: unknown,
): value is PaymentProviderName {
  return value === "manual" || value === "moyasar" || value === "tap";
}

/**
 * يسمح بالتحويل إلى صفحات HTTPS التابعة للمزوّد وحده.
 *
 * عنوان التحويل يأتي من استجابة شبكة خارجية ثم يُخزَّن في القاعدة ويصل إلى
 * `window.location.assign`. لذلك لا تكفي `new URL`: رابط صحيح نحويًّا إلى
 * نطاق مهاجم يبقى open redirect، ووجود userinfo قد يخفي المضيف بصريًّا.
 */
export function validateCheckoutUrl(
  provider: PaymentProviderName,
  value: unknown,
): string | null {
  if (provider === "manual" || typeof value !== "string") return null;
  if (value.length === 0 || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const allowed = CHECKOUT_HOST_SUFFIXES[provider].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );

  return allowed ? url.toString() : null;
}

/** عملة ISO-4217 بصيغة موحّدة، أو null عند أي قيمة غامضة. */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  return /^[A-Z]{3}$/u.test(normalized) ? normalized : null;
}

/** مقارنة مالية عند دقّة الحقل المحلي (هللتان)، بلا فروق floating عائمة. */
export function sameAmountAtTwoDecimals(a: number, b: number): boolean {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a > 0 &&
    b > 0 &&
    Math.round(a * 100) === Math.round(b * 100)
  );
}

/** fetch بمهلة صريحة؛ AbortError لا يحمل أسرار الطلب أو ترويساته. */
export async function fetchPaymentProvider(
  input: string,
  init: RequestInit,
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    throw new Error("INVALID_PAYMENT_PROVIDER_URL");
  }
  const allowedHosts = new Set(["api.moyasar.com", "api.tap.company"]);
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    (target.port !== "" && target.port !== "443") ||
    !allowedHosts.has(target.hostname.toLowerCase().replace(/\.$/u, ""))
  ) {
    throw new Error("INVALID_PAYMENT_PROVIDER_URL");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAYMENT_PROVIDER_TIMEOUT_MS);

  try {
    // Following redirects could move a credential-bearing request to a host
    // outside the reviewed provider endpoint. Financial calls fail closed.
    return await fetch(target.toString(), {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** يقرأ JSON مزوّد الدفع مع سقف بايتات حتى لو كذب Content-Length أو غاب. */
export async function readProviderJson(response: Response): Promise<unknown> {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    mediaType !== "application/json" &&
    !mediaType?.endsWith("+json")
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("INVALID_PROVIDER_CONTENT_TYPE");
  }
  const text = await readLimitedStream(
    response.body,
    response.headers.get("content-length"),
    MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("INVALID_PROVIDER_JSON");
  }
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maxBytes: number,
): Promise<string> {
  if (declaredLength != null) {
    if (!/^\d+$/u.test(declaredLength)) {
      await stream?.cancel("invalid content length").catch(() => undefined);
      throw new Error("INVALID_CONTENT_LENGTH");
    }
    if (Number(declaredLength) > maxBytes) {
      await stream?.cancel("response too large").catch(() => undefined);
      throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
    }
  }

  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response too large").catch(() => undefined);
      throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
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
    throw new Error("INVALID_PROVIDER_ENCODING");
  }
}
