import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import type { PaymentStatus } from "@/lib/generated/prisma/enums";
import {
  fetchPaymentProvider,
  normalizeCurrency,
  readProviderJson,
  sameAmountAtTwoDecimals,
  validateCheckoutUrl,
} from "./security";
import {
  assertFullRefundInput,
  PaymentError,
  secretMatches,
  type CreateIntentInput,
  type FullRefundInput,
  type PaymentProvider,
  type ProviderRefund,
  type ProviderIntent,
  type RetrieveRefundInput,
  type WebhookEvent,
} from "./types";

/**
 * بوابة Tap — مدى والبطاقات الائتمانية.
 *
 * الفرق الجوهري عن Moyasar وقد كلّف كثيرين خصمًا خاطئًا: **Tap تتوقّع
 * المبلغ بالريالات كعدد عشري**، بينما Moyasar تتوقّعه بالهللات كعدد صحيح.
 * الوحدة ليست اصطلاحًا موحّدًا بين البوابات، فمُذكورة صراحةً في كل ملف.
 */

const API = "https://api.tap.company/v2";

const TAP_CHARGE_ID = /^chg_[A-Za-z0-9_-]{3,140}$/u;
const TAP_REFUND_ID = /^re_[A-Za-z0-9_-]{3,140}$/u;
const tapStatusSchema = z.enum([
  "INITIATED",
  "PENDING",
  "IN_PROGRESS",
  "CAPTURED",
  "PAID",
  "DECLINED",
  "FAILED",
  "CANCELLED",
  "VOID",
  "VOIDED",
  "ABANDONED",
  "EXPIRED",
  "TIMEDOUT",
  "TIMED_OUT",
  "REFUNDED",
  "ACCEPTED",
  "REJECTED",
  "RESTRICTED",
  "UNKNOWN",
]);
const tapCurrencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/u)
  .transform((value) => value.toUpperCase());
const tapAmountSchema = z.number().finite().positive().max(1_000_000_000);
const tapReferenceSchema = z
  .object({
    gateway: z.string().max(255).nullish(),
    payment: z.string().max(255).nullish(),
    transaction: z.string().max(255).nullish(),
    order: z.string().max(100).nullish(),
    merchant: z.string().max(255).nullish(),
    idempotent: z.string().max(100).nullish(),
  })
  .nullish();
const tapResponseSchema = z
  .object({
    code: z.string().max(64).nullish(),
    message: z.string().max(500).nullish(),
  })
  .nullish();
const createdSchema = z.union([
  z.string().min(1).max(64),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
const tapChargeSchema = z.object({
  id: z.string().regex(TAP_CHARGE_ID),
  object: z.literal("charge"),
  status: tapStatusSchema,
  amount: tapAmountSchema,
  currency: tapCurrencySchema,
  reference: tapReferenceSchema,
  transaction: z.object({
    url: z.string().max(2_048).nullish(),
    created: createdSchema.nullish(),
  }),
  response: tapResponseSchema,
  metadata: z.record(z.string(), z.string()).optional(),
});
const tapRefundSchema = z.object({
  id: z.string().regex(TAP_REFUND_ID),
  object: z.literal("refund"),
  charge_id: z.string().regex(TAP_CHARGE_ID),
  status: tapStatusSchema,
  amount: tapAmountSchema,
  currency: tapCurrencySchema,
  reference: tapReferenceSchema,
  created: createdSchema,
  response: tapResponseSchema,
  metadata: z.record(z.string(), z.string()).optional(),
});
const tapWebhookSchema = z.discriminatedUnion("object", [
  tapChargeSchema,
  tapRefundSchema,
]);

export const tapProvider: PaymentProvider = {
  name: "tap",

  async create(input: CreateIntentInput): Promise<ProviderIntent> {
    const config = env();
    const currency = normalizeCurrency(config.STORE_CURRENCY);
    if (
      currency !== "SAR" ||
      input.currency !== currency ||
      !sameAmountAtTwoDecimals(input.amountSar, input.amountSar)
    ) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "amountSar لا يجوز إرساله إلى Tap بعملة غير SAR أو بدقّة غير صالحة",
      );
    }

    const amount = Number(input.amountSar.toFixed(2));
    const idempotent = `pay_${input.orderId}_${input.attempt}`.slice(0, 120);
    const returnUrl = requireHttpsUrl(input.returnUrl);
    const webhookUrl = requireHttpsUrl(
      new URL("/api/payments/webhook", config.STORE_PUBLIC_URL).toString(),
    );

    let res: Response;
    try {
      res = await fetchPaymentProvider(`${API}/charges`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.TAP_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
        // بالريالات كعدد عشري — لا هللات (راجع التعليق أعلى الملف)
        amount,
        currency,
        description: `طلبية ${input.orderNumber}`,
        // مرجعنا يعود في الإشعار فنطابق به بلا تخمين
        reference: {
          transaction: idempotent,
          order: input.orderNumber,
          // Tap تعيد الاستجابة الأصلية للمفتاح نفسه خلال نافذة الخمول.
          idempotent,
        },
        metadata: {
          order_id: input.orderId,
          attempt: String(input.attempt),
        },
        customer: {
          first_name: input.customerName || "عميل",
          ...(input.customerEmail ? { email: input.customerEmail } : {}),
        },
        source: { id: "src_all" },
        redirect: { url: returnUrl },
        post: { url: webhookUrl },
        // مهلة صفحة الدفع لدى المزوّد نفسها، فلا تبقى فاتورة حيّة قابلة
        // للدفع بعد أن تنتهي نيّتنا محليًّا (يمنع الخصم المزدوج).
        transaction: {
          expiry: { period: config.PAYMENT_EXPIRY_MINUTES, type: "MINUTE" },
        },
        }),
        cache: "no-store",
      });
    } catch {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "تعذّر الاتصال بـ Tap",
        { ambiguous: true },
      );
    }

    let payload: unknown;
    try {
      payload = await readProviderJson(res);
    } catch {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "استجابة Tap غير صالحة",
        { ambiguous: res.ok },
      );
    }

    if (!res.ok) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        `رفض Tap طلب إنشاء العملية (${res.status})`,
        { ambiguous: res.status >= 500 },
      );
    }

    const parsed = tapChargeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "بنية استجابة Tap غير متوقعة",
        { ambiguous: true },
      );
    }

    return chargeToIntent(parsed.data, input);
  },

  async retrieve(providerRef): Promise<WebhookEvent | null> {
    if (!TAP_CHARGE_ID.test(providerRef)) return null;
    const charge = await fetchCharge(providerRef);
    return chargeToEvent(charge, "reconciliation");
  },

  async refund(input: FullRefundInput): Promise<ProviderRefund> {
    assertFullRefundInput(input);
    if (!TAP_CHARGE_ID.test(input.providerRef)) {
      throw new PaymentError("PROVIDER_FAILED", "مرجع عملية Tap غير صالح");
    }

    const charge = await fetchCharge(input.providerRef);
    assertRefundableTapCharge(charge, input);
    return postTapFullRefund(input);
  },

  async retrieveRefund(input: RetrieveRefundInput): Promise<ProviderRefund> {
    assertFullRefundInput(input);
    if (
      !TAP_CHARGE_ID.test(input.providerRef) ||
      !TAP_REFUND_ID.test(input.refundRef)
    ) {
      throw new PaymentError("PROVIDER_FAILED", "مرجع استرداد Tap غير صالح");
    }
    const refund = await fetchTapRefund(input.refundRef);
    return refundToProviderResult(refund, input, "reconciliation");
  },

  async verifyWebhook(req, rawBody): Promise<WebhookEvent | null> {
    /**
     * ⚠️ توقيع Tap ليس سرًّا ثابتًا بل **HMAC-SHA256 يُحسب لكل إشعار**.
     *
     * كانت النسخة السابقة تقارن ترويسة `hashstring` بـ PAYMENT_WEBHOOK_SECRET
     * الثابت مباشرةً — وهي مقارنة تفشل **دائمًا** مع إشعار Tap حقيقي، فما من
     * دفعة تُسوّى أبدًا وتتجمّد كل طلبية مدفوعة. توثيق Top ينصّ على أن
     * `hashstring` تُبنى بربط حقول محدَّدة بترتيبها ثم توقيعها بمفتاح Tap
     * السرّي — فنُعيد بناء السلسلة نفسها ونقارن التوقيعين بزمن ثابت.
     */
    const presented = req.headers.get("hashstring") ?? "";
    return parseTapWebhook(rawBody, presented, env().TAP_SECRET_KEY);
  },
};

/** محلّل خالص تستعمله fixtures؛ يتعامل مع charge وrefund بصورتيهما. */
export function parseTapWebhook(
  rawBody: string,
  presentedHash: string,
  secret: string,
): WebhookEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  const parsed = tapWebhookSchema.safeParse(json);
  if (!parsed.success || !hashMatches(parsed.data, presentedHash, secret)) {
    return null;
  }

  const body = parsed.data;
  const status =
    body.object === "refund"
      ? mapRefundStatus(body.status)
      : mapChargeStatus(body.status);
  if (!status) return null;

  if (body.object === "charge") {
    return chargeToEvent(body, "webhook");
  }

  return {
    provider: "tap",
    // Refund.id يعرّف الاسترداد، لكن سجلّنا مربوط بالعملية الأصلية charge.id.
    providerRef: body.charge_id,
    status,
    failureCode: body.response?.code ?? undefined,
    failureMessage: body.response?.message ?? undefined,
    amountSar: body.amount,
    currency: body.currency,
    payload: body,
  };
}

async function fetchCharge(
  providerRef: string,
): Promise<z.infer<typeof tapChargeSchema>> {
  const config = env();
  let response: Response;
  try {
    response = await fetchPaymentProvider(
      `${API}/charges/${encodeURIComponent(providerRef)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${config.TAP_SECRET_KEY}` },
        cache: "no-store",
      },
    );
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "تعذّر التحقق من عملية Tap",
      { ambiguous: true },
    );
  }

  let payload: unknown;
  try {
    payload = await readProviderJson(response);
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "ردّ تحقق Tap غير صالح",
      { ambiguous: true },
    );
  }
  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      `تعذّر جلب عملية Tap للتحقق (${response.status})`,
      { ambiguous: true },
    );
  }

  const parsed = tapChargeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== providerRef) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "بنية عملية Tap الموثوقة غير متوقعة",
      { ambiguous: true },
    );
  }
  return parsed.data;
}

function assertRefundableTapCharge(
  charge: z.infer<typeof tapChargeSchema>,
  input: FullRefundInput,
): void {
  const configCurrency = normalizeCurrency(env().STORE_CURRENCY);
  if (
    charge.id !== input.providerRef ||
    (charge.status !== "CAPTURED" && charge.status !== "PAID") ||
    charge.currency !== input.currency ||
    configCurrency !== input.currency ||
    !sameAmountAtTwoDecimals(charge.amount, input.amountSar) ||
    charge.reference?.order !== input.orderNumber ||
    charge.metadata?.order_id !== input.orderId
  ) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "عملية Tap لا تطابق طلبية مدفوعة قابلة للاسترداد الكامل",
      { ambiguous: charge.status === "REFUNDED" },
    );
  }
}

async function postTapFullRefund(
  input: FullRefundInput,
): Promise<ProviderRefund> {
  const config = env();
  const callbackUrl = requireHttpsUrl(
    new URL("/api/payments/webhook", config.STORE_PUBLIC_URL).toString(),
  );
  const amount = Number(input.amountSar.toFixed(2));

  let response: Response;
  try {
    response = await fetchPaymentProvider(`${API}/refunds/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.TAP_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        charge_id: input.providerRef,
        // Tap يطلب amount حتى للاسترداد الكامل؛ يساوي حرفيًا مبلغ النيّة.
        amount,
        currency: input.currency,
        reason: input.reason,
        description: `Full refund for order ${input.orderNumber}`.slice(0, 250),
        reference: {
          transaction: input.idempotencyKey,
          order: input.orderNumber,
          idempotent: input.idempotencyKey,
        },
        metadata: {
          order_id: input.orderId,
          order_number: input.orderNumber,
          refund_key: input.idempotencyKey,
          refund_scope: "full",
        },
        post: { url: callbackUrl },
      }),
      cache: "no-store",
    });
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "تعذّر الاتصال بـ Tap لتنفيذ الاسترداد",
      { ambiguous: true },
    );
  }

  let payload: unknown;
  try {
    payload = await readProviderJson(response);
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "استجابة استرداد Tap غير صالحة",
      { ambiguous: response.ok },
    );
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      `رفض Tap طلب الاسترداد (${response.status})`,
      { ambiguous: response.status >= 500 || response.status === 409 },
    );
  }
  return parseTapRefundResponse(payload, input, "create");
}

async function fetchTapRefund(
  refundRef: string,
): Promise<z.infer<typeof tapRefundSchema>> {
  const config = env();
  let response: Response;
  try {
    response = await fetchPaymentProvider(
      `${API}/refunds/${encodeURIComponent(refundRef)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${config.TAP_SECRET_KEY}` },
        cache: "no-store",
      },
    );
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "تعذّر التحقق من استرداد Tap",
      { ambiguous: true },
    );
  }

  let payload: unknown;
  try {
    payload = await readProviderJson(response);
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "ردّ استرداد Tap غير صالح",
      { ambiguous: true },
    );
  }
  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      `تعذّر جلب استرداد Tap (${response.status})`,
      { ambiguous: true },
    );
  }

  const parsed = tapRefundSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== refundRef) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "بنية استرداد Tap الموثوقة غير متوقعة",
      { ambiguous: true },
    );
  }
  return parsed.data;
}

/** محلّل خالص لاستجابة Tap؛ يُصدّر لاختبارات العقود. */
export function parseTapRefundResponse(
  payload: unknown,
  input: FullRefundInput,
  source: "create" | "reconciliation" = "create",
): ProviderRefund {
  assertFullRefundInput(input);
  const parsed = tapRefundSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "بنية استجابة استرداد Tap غير متوقعة",
      { ambiguous: true },
    );
  }
  return refundToProviderResult(parsed.data, input, source);
}

function refundToProviderResult(
  refund: z.infer<typeof tapRefundSchema>,
  input: FullRefundInput,
  source: "create" | "reconciliation",
): ProviderRefund {
  const echoedIdempotency = refund.reference?.idempotent;
  const echoedRefundKey = refund.metadata?.refund_key;
  if (
    refund.charge_id !== input.providerRef ||
    refund.currency !== input.currency ||
    !sameAmountAtTwoDecimals(refund.amount, input.amountSar) ||
    (echoedIdempotency != null && echoedIdempotency !== input.idempotencyKey) ||
    (echoedRefundKey != null && echoedRefundKey !== input.idempotencyKey) ||
    (refund.metadata?.refund_scope != null &&
      refund.metadata.refund_scope !== "full") ||
    (refund.metadata?.order_id != null &&
      refund.metadata.order_id !== input.orderId) ||
    (refund.reference?.order != null &&
      refund.reference.order !== input.orderNumber)
  ) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "استجابة Tap لا تطابق كامل المبلغ أو العملة أو مراجع الطلبية",
      { ambiguous: true },
    );
  }

  const status = mapRefundStatus(refund.status);
  if (!status) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "حالة استرداد Tap غير معروفة",
      { ambiguous: true },
    );
  }

  return {
    provider: "tap",
    providerRef: input.providerRef,
    refundRef: refund.id,
    status:
      status === "REFUNDED"
        ? "REFUNDED"
        : status === "PENDING"
          ? "PENDING"
          : "FAILED",
    amountSar: input.amountSar,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    failureCode:
      status === "FAILED" ? (refund.response?.code ?? undefined) : undefined,
    failureMessage:
      status === "FAILED" ? (refund.response?.message ?? undefined) : undefined,
    payload: {
      source,
      refund: {
        id: refund.id,
        chargeId: refund.charge_id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
        reference: refund.reference,
        response: refund.response,
        created: refund.created,
      },
    },
  };
}

function chargeToIntent(
  charge: z.infer<typeof tapChargeSchema>,
  input: CreateIntentInput,
): ProviderIntent {
  const status = mapChargeStatus(charge.status);
  const checkoutUrl =
    charge.transaction.url == null
      ? null
      : validateCheckoutUrl("tap", charge.transaction.url);
  if (
    !status ||
    charge.currency !== input.currency ||
    !sameAmountAtTwoDecimals(charge.amount, input.amountSar) ||
    (charge.transaction.url != null && !checkoutUrl) ||
    ((status === "REQUIRES_ACTION" || status === "PENDING") && !checkoutUrl)
  ) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "رفضت استجابة Tap لاختلاف الحالة أو المبلغ أو العملة أو رابط الدفع",
      { ambiguous: true },
    );
  }

  return {
    providerRef: charge.id,
    checkoutUrl,
    status,
    amountSar: charge.amount,
    currency: charge.currency,
  };
}

function chargeToEvent(
  charge: z.infer<typeof tapChargeSchema>,
  source: "webhook" | "reconciliation",
): WebhookEvent | null {
  const unexpectedRefund = charge.status === "REFUNDED";
  const status = unexpectedRefund ? "FAILED" : mapChargeStatus(charge.status);
  if (!status) return null;
  return {
    provider: "tap",
    providerRef: charge.id,
    status,
    failureCode: charge.response?.code ?? undefined,
    failureMessage: charge.response?.message ?? undefined,
    requiresManualReview:
      unexpectedRefund || charge.status === "VOID" || charge.status === "VOIDED",
    amountSar: charge.amount,
    currency: charge.currency,
    payload: {
      source,
      charge: {
        id: charge.id,
        status: charge.status,
        amount: charge.amount,
        currency: charge.currency,
        reference: charge.reference,
        response: charge.response,
        transaction: { created: charge.transaction.created },
      },
    },
  };
}

/**
 * يتحقق من توقيع Tap (hashstring) بإعادة بناء السلسلة الموثّقة والمقارنة
 * بزمن ثابت. الترتيب والبادئات (`x_id` … `x_created`) كما ينصّ التوثيق،
 * والمبلغ منسَّق لخانتين عشريتين (دقّة الريال).
 */
function hashMatches(
  event: z.infer<typeof tapWebhookSchema>,
  presented: string,
  secret: string,
): boolean {
  if (!secret || !/^[0-9a-f]{64}$/iu.test(presented)) return false;

  const amount = event.amount.toFixed(currencyFractionDigits(event.currency));
  const created =
    event.object === "refund" ? event.created : event.transaction.created;
  const base =
    `x_id${event.id}` +
    `x_amount${amount}` +
    `x_currency${event.currency}` +
    `x_gateway_reference${event.reference?.gateway ?? ""}` +
    `x_payment_reference${event.reference?.payment ?? ""}` +
    `x_status${event.status}` +
    `x_created${created ?? ""}`;

  const expected = createHmac("sha256", secret).update(base).digest("hex");
  return secretMatches(presented.toLowerCase(), expected);
}

function mapChargeStatus(
  raw: z.infer<typeof tapStatusSchema>,
): PaymentStatus | null {
  switch (raw) {
    case "CAPTURED":
    case "PAID":
      return "PAID";
    case "DECLINED":
    case "FAILED":
    case "CANCELLED":
    case "VOID":
    case "VOIDED":
    case "ABANDONED":
    case "RESTRICTED":
    case "UNKNOWN":
      return "FAILED";
    case "EXPIRED":
    case "TIMEDOUT":
    case "TIMED_OUT":
      return "EXPIRED";
    case "INITIATED":
      return "REQUIRES_ACTION";
    case "PENDING":
    case "IN_PROGRESS":
      return "PENDING";
    // Tap توثّق الاسترداد ككائن refund مستقل يحمل مبلغ الاسترداد الفعلي.
    // قبول REFUNDED من charge سيقارن مبلغ الخصم الأصلي كأنه مبلغ مسترد.
    case "REFUNDED":
      return null;
    default:
      return null;
  }
}

function mapRefundStatus(
  raw: z.infer<typeof tapStatusSchema>,
): PaymentStatus | null {
  switch (raw) {
    case "REFUNDED":
      return "REFUNDED";
    case "PENDING":
    case "ACCEPTED":
    case "IN_PROGRESS":
    case "INITIATED":
      return "PENDING";
    case "DECLINED":
    case "FAILED":
    case "REJECTED":
    case "RESTRICTED":
    case "CANCELLED":
    case "VOID":
    case "VOIDED":
    case "ABANDONED":
    case "EXPIRED":
    case "TIMEDOUT":
    case "TIMED_OUT":
    case "UNKNOWN":
      return "FAILED";
    default:
      return null;
  }
}

/** Tap توثّق 3 منازل لهذه العملات، ومنزلتين لبقية عملاتها المدعومة. */
function currencyFractionDigits(currency: string): number {
  return ["BHD", "JOD", "KWD", "OMR"].includes(currency) ? 3 : 2;
}

function requireHttpsUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PaymentError("PROVIDER_FAILED", "عناوين Tap العامة يجب أن تكون HTTPS");
  }
  return url.toString();
}
