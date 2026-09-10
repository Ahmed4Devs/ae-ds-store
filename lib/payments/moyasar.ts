import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeDatabaseRateLimit } from "@/lib/database-rate-limit";
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
 * بوابة Moyasar — مدى والبطاقات الائتمانية.
 *
 * استُدعيت بـ fetch مباشرةً لا بحزمة رسمية: الواجهة هنا ثلاثة طلبات بسيطة،
 * وإضافة اعتمادية لأجلها تزيد سطح التحديث بلا مقابل.
 */

const API = "https://api.moyasar.com/v1";

const MOYASAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const invoiceStatusSchema = z.enum([
  "initiated",
  "paid",
  "captured",
  "failed",
  "declined",
  "refunded",
  "canceled",
  "on_hold",
  "pending",
  "expired",
  "voided",
]);
const paymentStatusSchema = z.enum([
  "initiated",
  "paid",
  "authorized",
  "failed",
  "refunded",
  "captured",
  "voided",
  "verified",
]);
const currencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/u)
  .transform((value) => value.toUpperCase());
const amountMinorSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const refundedMinorSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const invoicePaymentSchema = z.object({
  id: z.string().regex(MOYASAR_ID),
  status: paymentStatusSchema,
  amount: amountMinorSchema,
  currency: currencySchema,
  refunded: refundedMinorSchema,
  captured: refundedMinorSchema.optional(),
  invoice_id: z.string().regex(MOYASAR_ID).nullish(),
});
const invoiceSchema = z.object({
  id: z.string().regex(MOYASAR_ID),
  status: invoiceStatusSchema,
  amount: amountMinorSchema,
  currency: currencySchema,
  url: z.string().max(2_048).nullish(),
  metadata: z.record(z.string(), z.string()).optional(),
  payments: z.array(invoicePaymentSchema).max(100).optional(),
  source: z
    .object({ message: z.string().max(500).nullish() })
    .nullish(),
});
const invoiceListSchema = z.object({
  invoices: z.array(invoiceSchema).max(100),
});
const signedWebhookSchema = z.object({
  type: z
    .enum([
      "payment_paid",
      "payment_failed",
      "payment_refunded",
      "payment_voided",
      "payment_authorized",
      "payment_captured",
      "payment_verified",
    ])
    .optional(),
  secret_token: z.string().min(1).max(512).optional(),
  data: z
    .object({
      id: z.string().regex(MOYASAR_ID).optional(),
      invoice_id: z.string().regex(MOYASAR_ID).optional(),
      status: paymentStatusSchema,
      amount: amountMinorSchema,
      refunded: refundedMinorSchema.optional(),
      currency: currencySchema,
      source: z
        .object({ message: z.string().max(500).nullish() })
        .nullish(),
    })
    .refine((data) => Boolean(data.invoice_id || data.id)),
});

export const moyasarProvider: PaymentProvider = {
  name: "moyasar",

  async create(input: CreateIntentInput): Promise<ProviderIntent> {
    const config = env();
    const currency = normalizeCurrency(config.STORE_CURRENCY);
    if (currency !== "SAR") {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "amountSar لا يجوز إرساله إلى Moyasar بعملة غير SAR",
      );
    }

    const amountMinor = Math.round(input.amountSar * 100);
    if (
      amountMinor < 100 ||
      !sameAmountAtTwoDecimals(input.amountSar, amountMinor / 100)
    ) {
      throw new PaymentError("PROVIDER_FAILED", "مبلغ Moyasar غير صالح");
    }

    if (input.recovery !== "none") {
      const recovered = await findRecoveryInvoice(input);
      if (recovered) return invoiceToIntent(recovered, input);

      // Invoice API لا تدعم given_id (على خلاف Payments API). بعد انقطاع
      // أو timeout لا يمكن إثبات أن POST الأول لم يُنشئ فاتورة لم تظهر بعد
      // في القائمة؛ إعادة POST هنا قد تنشئ رابطين صالحين لنفس الطلبية.
      if (input.recovery === "reconcile-only") {
        throw new PaymentError(
          "PROVIDER_FAILED",
          "تعذّر حسم نتيجة إنشاء فاتورة Moyasar السابقة",
          { ambiguous: true },
        );
      }
    }

    const callbackUrl = requireHttpsUrl(
      new URL("/api/payments/webhook", config.STORE_PUBLIC_URL).toString(),
    );
    const returnUrl = requireHttpsUrl(input.returnUrl);

    let res: Response;
    try {
      res = await fetchPaymentProvider(`${API}/invoices`, {
        method: "POST",
        headers: {
          Authorization: basicAuth(config.MOYASAR_SECRET_KEY),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
        /**
         * ⚠️ المبلغ بالهللات لا بالريالات.
         *
         * هذا أشهر عطل في دمج البوابات السعودية: إرسال 250 بدل 25000 يخصم
         * ريالين ونصفًا بدل مئتين وخمسين، وإرسال الريالات حيث تُتوقّع
         * الهللات يخصم مئة ضعف. الضرب في مئة والتقريب إلى عدد صحيح شرطٌ
         * لا تنسيق — والبوابة ترفض الكسور العشرية أصلًا.
         */
        amount: amountMinor,
        currency,
        description: `طلبية ${input.orderNumber}`,
        // callback خادمي للإشعار، وsuccess لإعادة المتصفّح — ليسا الشيء نفسه.
        callback_url: callbackUrl,
        success_url: returnUrl,
        back_url: returnUrl,
        // تموت الفاتورة لدى المزوّد حين تنتهي نيّتنا محليًّا، فلا تبقى
        // قابلة للدفع بعد أن يبدأ العميل محاولة جديدة (يمنع الخصم المزدوج).
        expired_at: input.expiresAt.toISOString(),
        // مرجعنا يعود إلينا في الإشعار فنطابق به بلا بحث تخميني
        metadata: {
          order_id: input.orderId,
          order_number: input.orderNumber,
          attempt: String(input.attempt),
        },
        }),
        cache: "no-store",
      });
    } catch {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "تعذّر الاتصال بـ Moyasar",
        { ambiguous: true },
      );
    }

    let payload: unknown;
    try {
      payload = await readProviderJson(res);
    } catch {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "استجابة Moyasar غير صالحة",
        { ambiguous: res.ok },
      );
    }

    if (!res.ok) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        `رفض Moyasar طلب إنشاء الفاتورة (${res.status})`,
        { ambiguous: res.status >= 500 },
      );
    }

    const parsed = invoiceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "بنية استجابة Moyasar غير متوقعة",
        { ambiguous: true },
      );
    }

    return invoiceToIntent(parsed.data, input);
  },

  async retrieve(providerRef): Promise<WebhookEvent | null> {
    if (!MOYASAR_ID.test(providerRef)) return null;
    const invoice = await fetchInvoice(providerRef);
    return invoiceToEvent(invoice, "reconciliation");
  },

  async refund(input: FullRefundInput): Promise<ProviderRefund> {
    assertFullRefundInput(input);
    if (!MOYASAR_ID.test(input.providerRef)) {
      throw new PaymentError("PROVIDER_FAILED", "مرجع فاتورة Moyasar غير صالح");
    }

    const invoice = await fetchInvoice(input.providerRef);
    const payment = selectFullRefundPayment(invoice, input);
    const existing = paymentToRefund(payment, input, "preflight", payment.id);
    if (existing.status === "REFUNDED") return existing;

    return postFullRefund(payment.id, input);
  },

  async retrieveRefund(input: RetrieveRefundInput): Promise<ProviderRefund> {
    assertFullRefundInput(input);
    if (
      !MOYASAR_ID.test(input.providerRef) ||
      !MOYASAR_ID.test(input.refundRef)
    ) {
      throw new PaymentError("PROVIDER_FAILED", "مرجع استرداد Moyasar غير صالح");
    }
    const payment = await fetchPayment(input.refundRef);
    return paymentToRefund(payment, input, "reconciliation", input.refundRef);
  },

  async verifyWebhook(req, rawBody): Promise<WebhookEvent | null> {
    /**
     * تتحقق Moyasar من هوية الإشعار بسرّ مشترك تُرسله في الحمولة، لا
     * بتوقيع HMAC على الجسم. لذلك نقارن السرّ بزمن ثابت ونرفض ما لا
     * يطابق — والمقارنة العادية تسرّب طول التطابق عبر زمن التنفيذ.
     */
    const config = env();
    const signed = parseSignedMoyasarWebhook(
      rawBody,
      config.PAYMENT_WEBHOOK_SECRET,
      req.headers.get("x-moyasar-token") ?? "",
    );
    if (signed) return signed;

    /**
     * callback_url الخاص بالفواتير يرسل كائن الفاتورة ولا يوقّعه. لا نثق
     * بحالته المالية: نقبل معرّف فاتورة محلية فقط، ثم نجلب النسخة الموثوقة
     * من Moyasar بالمفتاح السري ونبني الحدث منها. هكذا يعمل callback الحقيقي
     * من دون تحويل جسم غير موثّق إلى PAID.
     */
    const callback = parseJson(rawBody);
    const candidate = invoiceSchema.safeParse(callback);
    if (!candidate.success || !config.MOYASAR_SECRET_KEY) return null;

    const local = await prisma.paymentIntent.findFirst({
      where: { provider: "moyasar", providerRef: candidate.data.id },
      select: { orderId: true },
    });
    if (!local) return null;

    // callback_url غير موقّع، والتحقق النهائي يحتاج GET مدفوعًا إلى Moyasar.
    // لا نستهلك الميزانية العامة إلا بعد إثبات أن المرجع موجود محليًا؛ وإلا
    // استطاع مهاجم تدوير UUIDs عشوائية وحجب callbacks المشروعة بلا أي فاتورة.
    const refDigest = createHash("sha256")
      .update(candidate.data.id)
      .digest("base64url");
    const [globalBudget, referenceBudget] = await Promise.all([
      consumeDatabaseRateLimit("payments:moyasar-callback:global", 300, 60_000),
      consumeDatabaseRateLimit(
        `payments:moyasar-callback:${refDigest}`,
        6,
        60_000,
      ),
    ]);
    if (!globalBudget.ok || !referenceBudget.ok) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        "تجاوزت مصالحة callback الحد الآمن المؤقت",
        { ambiguous: true },
      );
    }

    const authoritative = await fetchInvoice(candidate.data.id);
    if (
      authoritative.id !== candidate.data.id ||
      authoritative.metadata?.order_id !== local.orderId
    ) {
      return null;
    }

    return invoiceToEvent(authoritative, "invoice-callback");
  },
};

/** محلّل خالص تستعمله fixtures كذلك؛ لا يتصل بالشبكة ولا يقرأ البيئة. */
export function parseSignedMoyasarWebhook(
  rawBody: string,
  expectedSecret: string,
  headerSecret = "",
): WebhookEvent | null {
  const parsed = signedWebhookSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) return null;

  const presented = parsed.data.secret_token ?? headerSecret;
  if (!secretMatches(presented, expectedSecret)) return null;

  const data = parsed.data.data;
  const status = mapStatus(data.status);
  if (!status) return null;

  return {
    provider: "moyasar",
    providerRef: data.invoice_id ?? data.id ?? "",
    status,
    failureCode: data.source?.message ? "DECLINED" : undefined,
    failureMessage: data.source?.message ?? undefined,
    // في الاسترداد يبقى amount هو أصل الخصم حتى لو كان الاسترداد جزئيًا؛
    // refunded هو الإثبات المالي الفعلي. غيابه يصير صفرًا فيفشل التساوي
    // ويُرفع للمراجعة بدل إعلان استرداد كامل كاذب.
    amountSar:
      status === "REFUNDED" ? (data.refunded ?? 0) / 100 : data.amount / 100,
    currency: data.currency,
    requiresManualReview: data.status === "voided",
    payload: parsed.data,
  };
}

async function findRecoveryInvoice(
  input: CreateIntentInput,
): Promise<z.infer<typeof invoiceSchema> | null> {
  const config = env();
  const url = new URL(`${API}/invoices`);
  url.searchParams.set("metadata[order_id]", input.orderId);
  url.searchParams.set("page", "1");

  let response: Response;
  try {
    response = await fetchPaymentProvider(url.toString(), {
      method: "GET",
      headers: { Authorization: basicAuth(config.MOYASAR_SECRET_KEY) },
      cache: "no-store",
    });
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "تعذّر البحث عن فاتورة Moyasar السابقة",
      { ambiguous: true },
    );
  }

  let payload: unknown;
  try {
    payload = await readProviderJson(response);
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "ردّ مصالحة Moyasar غير صالح",
      { ambiguous: true },
    );
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      `تعذّر البحث عن فاتورة Moyasar السابقة (${response.status})`,
      { ambiguous: true },
    );
  }

  const parsed = invoiceListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "بنية قائمة فواتير Moyasar غير متوقعة",
      { ambiguous: true },
    );
  }

  const matches = parsed.data.invoices.filter(
    (invoice) =>
      invoice.metadata?.order_id === input.orderId &&
      invoice.metadata?.attempt === String(input.attempt),
  );
  if (matches.length > 1) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "وُجدت أكثر من فاتورة Moyasar للمحاولة نفسها",
      { ambiguous: true },
    );
  }
  return matches[0] ?? null;
}

async function fetchInvoice(
  providerRef: string,
): Promise<z.infer<typeof invoiceSchema>> {
  const config = env();
  let response: Response;
  try {
    response = await fetchPaymentProvider(
      `${API}/invoices/${encodeURIComponent(providerRef)}`,
      {
        method: "GET",
        headers: { Authorization: basicAuth(config.MOYASAR_SECRET_KEY) },
        cache: "no-store",
      },
    );
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "تعذّر التحقق من فاتورة Moyasar",
      { ambiguous: true },
    );
  }

  let payload: unknown;
  try {
    payload = await readProviderJson(response);
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "ردّ تحقق Moyasar غير صالح",
      { ambiguous: true },
    );
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      `تعذّر جلب فاتورة Moyasar للتحقق (${response.status})`,
      { ambiguous: true },
    );
  }

  const parsed = invoiceSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== providerRef) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "بنية فاتورة Moyasar الموثوقة غير متوقعة",
      { ambiguous: true },
    );
  }
  return parsed.data;
}

function selectFullRefundPayment(
  invoice: z.infer<typeof invoiceSchema>,
  input: FullRefundInput,
): z.infer<typeof invoicePaymentSchema> {
  const expectedMinor = Math.round(input.amountSar * 100);
  const matchingReference =
    invoice.metadata?.order_id === input.orderId &&
    invoice.metadata?.order_number === input.orderNumber;

  if (
    invoice.id !== input.providerRef ||
    invoice.currency !== input.currency ||
    invoice.amount !== expectedMinor ||
    !matchingReference
  ) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "فاتورة Moyasar لا تطابق مرجع الطلبية أو مبلغها أو عملتها",
      { ambiguous: true },
    );
  }

  const candidates = (invoice.payments ?? []).filter((payment) =>
    ["paid", "captured", "refunded"].includes(payment.status),
  );
  if (candidates.length !== 1) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "تعذّر تحديد دفعة Moyasar وحيدة قابلة للاسترداد",
      { ambiguous: true },
    );
  }

  const payment = candidates[0];
  const chargedMinor =
    payment.status === "captured"
      ? payment.captured
      : payment.amount;
  if (
    payment.currency !== input.currency ||
    chargedMinor !== expectedMinor ||
    payment.invoice_id !== input.providerRef ||
    payment.refunded > expectedMinor ||
    (payment.refunded > 0 && payment.refunded < expectedMinor)
  ) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "دفعة Moyasar لا تمثل استردادًا كاملًا وآمنًا للطلبية",
      { ambiguous: true },
    );
  }
  return payment;
}

async function postFullRefund(
  paymentId: string,
  input: FullRefundInput,
): Promise<ProviderRefund> {
  const config = env();
  let response: Response;
  try {
    response = await fetchPaymentProvider(
      `${API}/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: basicAuth(config.MOYASAR_SECRET_KEY),
          Accept: "application/json",
        },
        // غياب amount هو full refund وفق توثيق Moyasar؛ لا نرسل body حتى
        // لا يستطيع تغيير عابر في الوحدة أن يحوّلها إلى partial refund.
        cache: "no-store",
      },
    );
  } catch {
    return reconcileMoyasarRefundAfterAmbiguity(paymentId, input);
  }

  let payload: unknown;
  try {
    payload = await readProviderJson(response);
  } catch {
    return reconcileMoyasarRefundAfterAmbiguity(paymentId, input);
  }

  if (!response.ok) {
    const reconciled = await tryReconcileMoyasarRefund(paymentId, input);
    if (reconciled?.status === "REFUNDED") return reconciled;
    throw new PaymentError(
      "PROVIDER_FAILED",
      `رفض Moyasar طلب الاسترداد (${response.status})`,
      { ambiguous: response.status >= 500 },
    );
  }

  try {
    return parseMoyasarRefundResponse(payload, input, "create", paymentId);
  } catch {
    return reconcileMoyasarRefundAfterAmbiguity(paymentId, input);
  }
}

async function fetchPayment(
  paymentId: string,
): Promise<z.infer<typeof invoicePaymentSchema>> {
  const config = env();
  let response: Response;
  try {
    response = await fetchPaymentProvider(
      `${API}/payments/${encodeURIComponent(paymentId)}`,
      {
        method: "GET",
        headers: { Authorization: basicAuth(config.MOYASAR_SECRET_KEY) },
        cache: "no-store",
      },
    );
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "تعذّر التحقق من استرداد Moyasar",
      { ambiguous: true },
    );
  }

  let payload: unknown;
  try {
    payload = await readProviderJson(response);
  } catch {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "ردّ استرداد Moyasar غير صالح",
      { ambiguous: true },
    );
  }
  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      `تعذّر جلب استرداد Moyasar (${response.status})`,
      { ambiguous: true },
    );
  }

  const parsed = invoicePaymentSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== paymentId) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "بنية استرداد Moyasar الموثوقة غير متوقعة",
      { ambiguous: true },
    );
  }
  return parsed.data;
}

async function tryReconcileMoyasarRefund(
  paymentId: string,
  input: FullRefundInput,
): Promise<ProviderRefund | null> {
  try {
    const payment = await fetchPayment(paymentId);
    return paymentToRefund(payment, input, "reconciliation");
  } catch {
    return null;
  }
}

async function reconcileMoyasarRefundAfterAmbiguity(
  paymentId: string,
  input: FullRefundInput,
): Promise<ProviderRefund> {
  const reconciled = await tryReconcileMoyasarRefund(paymentId, input);
  if (reconciled?.status === "REFUNDED") return reconciled;
  throw new PaymentError(
    "PROVIDER_FAILED",
    "تعذّر حسم نتيجة استرداد Moyasar",
    { ambiguous: true },
  );
}

/** محلّل خالص لاستجابة POST refund؛ يُصدّر لاختبارات العقود. */
export function parseMoyasarRefundResponse(
  payload: unknown,
  input: FullRefundInput,
  source: "create" | "reconciliation" = "create",
  expectedPaymentId?: string,
): ProviderRefund {
  assertFullRefundInput(input);
  const parsed = invoicePaymentSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "بنية استجابة استرداد Moyasar غير متوقعة",
      { ambiguous: true },
    );
  }
  return paymentToRefund(parsed.data, input, source, expectedPaymentId);
}

function paymentToRefund(
  payment: z.infer<typeof invoicePaymentSchema>,
  input: FullRefundInput,
  source: "create" | "preflight" | "reconciliation",
  expectedPaymentId?: string,
): ProviderRefund {
  const expectedMinor = Math.round(input.amountSar * 100);
  const chargedMinor =
    payment.status === "captured"
      ? payment.captured
      : payment.amount;
  if (
    (expectedPaymentId != null && payment.id !== expectedPaymentId) ||
    payment.currency !== input.currency ||
    chargedMinor !== expectedMinor ||
    payment.invoice_id !== input.providerRef ||
    payment.refunded > expectedMinor ||
    (payment.refunded > 0 && payment.refunded < expectedMinor)
  ) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "استجابة Moyasar لا تطابق كامل المبلغ أو العملة أو الفاتورة",
      { ambiguous: true },
    );
  }

  let status: ProviderRefund["status"];
  if (payment.status === "refunded" && payment.refunded === expectedMinor) {
    status = "REFUNDED";
  } else if (
    (payment.status === "paid" || payment.status === "captured") &&
    payment.refunded === 0
  ) {
    status = "PENDING";
  } else if (payment.status === "failed" || payment.status === "voided") {
    status = "FAILED";
  } else {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "حالة استرداد Moyasar متناقضة",
      { ambiguous: true },
    );
  }

  return {
    provider: "moyasar",
    providerRef: input.providerRef,
    refundRef: payment.id,
    status,
    amountSar: input.amountSar,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    payload: {
      source,
      payment: {
        id: payment.id,
        invoiceId: payment.invoice_id ?? input.providerRef,
        status: payment.status,
        amount: payment.amount,
        captured: payment.captured,
        refunded: payment.refunded,
        currency: payment.currency,
      },
    },
  };
}

function invoiceToIntent(
  invoice: z.infer<typeof invoiceSchema>,
  input: CreateIntentInput,
): ProviderIntent {
  const status = mapStatus(invoice.status);
  const amountSar =
    status === "REFUNDED"
      ? refundedInvoiceAmountMinor(invoice) / 100
      : invoice.amount / 100;
  const currency = normalizeCurrency(invoice.currency);
  const checkoutUrl =
    invoice.url == null ? null : validateCheckoutUrl("moyasar", invoice.url);

  if (
    !status ||
    !currency ||
    currency !== input.currency ||
    !sameAmountAtTwoDecimals(amountSar, input.amountSar) ||
    (invoice.url != null && !checkoutUrl) ||
    ((status === "REQUIRES_ACTION" || status === "PENDING") && !checkoutUrl)
  ) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "رفضت استجابة Moyasar لاختلاف الحالة أو المبلغ أو العملة أو رابط الدفع",
      { ambiguous: true },
    );
  }

  return {
    providerRef: invoice.id,
    checkoutUrl,
    status,
    amountSar,
    currency,
  };
}

function basicAuth(secretKey: string): string {
  // المفتاح السري اسمُ المستخدم وكلمة المرور فارغة — كما ينص توثيق Moyasar
  return `Basic ${Buffer.from(`${secretKey}:`, "utf8").toString("base64")}`;
}

/** ترجمة مغلقة: الحالة غير المعروفة تُرفض ولا تُخفى كـ PENDING. */
function mapStatus(
  raw:
    | z.infer<typeof invoiceStatusSchema>
    | z.infer<typeof paymentStatusSchema>,
): PaymentStatus | null {
  switch (raw.toLowerCase()) {
    case "paid":
    case "captured":
      return "PAID";
    case "failed":
    case "declined":
    case "voided":
    case "canceled":
      return "FAILED";
    case "expired":
      return "EXPIRED";
    case "refunded":
      return "REFUNDED";
    case "initiated":
      return "REQUIRES_ACTION";
    case "on_hold":
    case "pending":
    case "authorized":
    case "verified":
      return "PENDING";
    default:
      return null;
  }
}

function invoiceToEvent(
  invoice: z.infer<typeof invoiceSchema>,
  source: "invoice-callback" | "reconciliation",
): WebhookEvent | null {
  const status = mapStatus(invoice.status);
  if (!status) return null;
  return {
    provider: "moyasar",
    providerRef: invoice.id,
    status,
    failureCode: invoice.source?.message ? "DECLINED" : undefined,
    failureMessage: invoice.source?.message ?? undefined,
    amountSar:
      status === "REFUNDED"
        ? refundedInvoiceAmountMinor(invoice) / 100
        : invoice.amount / 100,
    currency: invoice.currency,
    requiresManualReview: invoice.status === "voided",
    payload: {
      source,
      invoice: {
        id: invoice.id,
        status: invoice.status,
        amount: invoice.amount,
        refunded: invoice.payments?.map((payment) => ({
          id: payment.id,
          amount: payment.amount,
          refunded: payment.refunded,
          currency: payment.currency,
        })),
        currency: invoice.currency,
        metadata: invoice.metadata,
      },
    },
  };
}

/** مجموع ما أعيد فعلًا عبر محاولات الدفع التابعة للفاتورة. */
function refundedInvoiceAmountMinor(
  invoice: z.infer<typeof invoiceSchema>,
): number {
  if (!invoice.payments || invoice.payments.length === 0) return 0;
  let total = 0;
  for (const payment of invoice.payments) {
    if (payment.currency !== invoice.currency) return 0;
    total += payment.refunded;
    if (!Number.isSafeInteger(total) || total > invoice.amount) return 0;
  }
  return total;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function requireHttpsUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PaymentError("PROVIDER_FAILED", "عناوين Moyasar العامة يجب أن تكون HTTPS");
  }
  return url.toString();
}
