import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import {
  backfillRecoverableSourceJobs,
  enqueueSourceOrderJob,
  processSourceOrderJobs,
} from "@/lib/order-jobs";
import { safeErrorKind } from "@/lib/safe-log";
import { DEFAULT_LOCALE, dictionaries, type Locale } from "@/lib/i18n/shared";
import { shippingAddressSchema } from "@/lib/ksa";
import type { PaymentStatus } from "@/lib/generated/prisma/enums";
import { manualProvider } from "./manual";
import { moyasarProvider } from "./moyasar";
import { tapProvider } from "./tap";
import {
  isPaymentProviderName,
  normalizeCurrency,
  sameAmountAtTwoDecimals,
  validateCheckoutUrl,
} from "./security";
import {
  PaymentError,
  type PaymentProvider,
  type PaymentProviderName,
} from "./types";

/**
 * واجهة الدفع الوحيدة لبقية المتجر.
 *
 * لماذا طبقة نيّات دفع أصلًا بدل «تحديد الطلبية كمدفوعة»؟ لأن الدفع خطوة
 * **خارجية غير متزامنة**: ننشئ النيّة، يغادر العميل إلى صفحة المزوّد، ثم
 * يصل التأكيد عبر إشعار خادم-إلى-خادم قد يسبق عودة العميل أو يتأخّر عنها
 * أو يصل مرتين. بلا سجلّ مستقلّ لكل محاولة لا يمكن التوفيق بين الطرفين،
 * ولا كشفُ الإشعار المكرّر — وتكرار الإشعار يعني شراء الطلبية مرتين من
 * AliExpress.
 */

const PROVIDERS: Record<PaymentProviderName, PaymentProvider> = {
  manual: manualProvider,
  moyasar: moyasarProvider,
  tap: tapProvider,
};

export function activeProvider(): PaymentProviderName {
  return env().PAYMENT_PROVIDER;
}

function provider(): PaymentProvider {
  return PROVIDERS[activeProvider()];
}

/** الحالات التي تعني أن النيّة ما زالت قابلة للتسوية. */
const OPEN_STATUSES: readonly PaymentStatus[] = ["REQUIRES_ACTION", "PENDING"];
const FINAL_STATUSES: readonly PaymentStatus[] = [
  "PAID",
  "FAILED",
  "EXPIRED",
  "REFUNDED",
];
const CREATION_LEASE_MS = 30_000;
// Tap توثّق خمول مفتاح الإنشاء 24 ساعة؛ نترك هامش ساعة لانحراف الساعات.
const TAP_IDEMPOTENCY_RETRY_MS = 23 * 60 * 60 * 1000;
const CREATION_RESERVED = "CREATION_RESERVED";
const CREATION_STARTED = "CREATE_REQUEST_STARTED";
const CREATION_RETRYABLE = "CREATE_RETRYABLE";
const CREATION_AMBIGUOUS = "CREATE_AMBIGUOUS";

/** Provider strings are untrusted even after signature verification. */
export function sanitizePaymentFailureCode(value?: string): string | null {
  if (value === undefined) return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return normalized || "PROVIDER_FAILURE";
}

export function sanitizePaymentFailureMessage(value?: string): string | null {
  if (value === undefined) return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
  return normalized || null;
}

export interface CreatedIntent {
  intentId: string;
  providerRef: string;
  checkoutUrl: string | null;
  status: PaymentStatus;
  amountSar: number;
}

/**
 * ينشئ نيّة دفع لطلبية.
 *
 * المبلغ يُقرأ من `order.totalSar` المخزَّن ولا يُعاد حسابه هنا: الطلبية
 * ثُبِّتت بسعر صرف محدَّد وأسعار محدَّثة وقت إنشائها، وإعادة الحساب الآن
 * قد تُطالب العميل بمبلغ يخالف ما رآه ووافق عليه.
 */
export async function createPaymentIntent(
  orderId: string,
): Promise<CreatedIntent> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      needsManualReview: true,
      totalSar: true,
      user: { select: { email: true, name: true } },
      shippingSnapshot: true,
      payments: {
        where: { status: "PAID" },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!order) throw new PaymentError("ORDER_NOT_FOUND");

  if (order.status === "PAID" || order.status === "SOURCED" || order.payments.length > 0) {
    throw new PaymentError("ALREADY_PAID");
  }
  if (order.status !== "PENDING_PAYMENT" || order.needsManualReview) {
    // ملغاة أو مشحونة أو قيد التوريد — لا معنى لدفع جديد عليها
    throw new PaymentError("ORDER_NOT_PAYABLE");
  }

  const now = new Date();

  const amountSar = Number(order.totalSar);
  const currency = normalizeCurrency(env().STORE_CURRENCY);
  if (currency !== "SAR" || !sameAmountAtTwoDecimals(amountSar, amountSar)) {
    throw new PaymentError("PROVIDER_FAILED", "مبلغ الطلبية أو عملتها غير صالحين");
  }
  const snapshot = shippingAddressSchema.safeParse(order.shippingSnapshot);
  if (!snapshot.success) {
    await requireManualReview(order.id, "INVALID_PAYMENT_SNAPSHOT");
    throw new PaymentError("ORDER_NOT_PAYABLE");
  }

  // إن وُجد حجز/نية مفتوحة نعالجها أولًا. الأهم: لا نعلن انتهاء نية بوابة
  // خارجية محليًا قبل جلب حالتها؛ فقد تكون دُفعت وفُقد webhook.
  const existing = await findOpenIntent(order.id);
  if (existing) {
    const handled = await handleOpenIntent(
      {
        id: order.id,
        orderNumber: order.orderNumber,
        amountSar,
        currency,
        customerEmail: order.user?.email,
        customerName: order.user?.name ?? snapshot.data.fullName,
      },
      existing,
      now,
    );
    if (handled) return handled;
  }

  const selectedProvider = provider();
  const expiresAt = new Date(
    Date.now() + env().PAYMENT_EXPIRY_MINUTES * 60 * 1000,
  );

  let reservation;
  try {
    reservation = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE
      `;
      const currentOrder = await tx.order.findUnique({
        where: { id: order.id },
        select: {
          status: true,
          needsManualReview: true,
          payments: {
            where: { status: "PAID" },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (
        currentOrder?.status !== "PENDING_PAYMENT" ||
        currentOrder.needsManualReview
      ) {
        throw new PaymentError("ORDER_NOT_PAYABLE");
      }
      if (currentOrder.payments.length > 0) {
        throw new PaymentError("ALREADY_PAID");
      }

      const concurrent = await tx.paymentIntent.findFirst({
        where: { orderId: order.id, status: { in: [...OPEN_STATUSES] } },
        orderBy: { createdAt: "desc" },
      });
      if (concurrent) return { row: concurrent, ownsLease: false, attempt: 0 };

      const attempt = (await tx.paymentIntent.count({ where: { orderId: order.id } })) + 1;
      const localRef = creationRef(selectedProvider.name, order.id, attempt);
      const row = await tx.paymentIntent.create({
        data: {
          orderId: order.id,
          provider: selectedProvider.name,
          providerRef: localRef,
          status: "PENDING",
          amountSar,
          currency,
          checkoutUrl: null,
          expiresAt,
          failureCode: CREATION_RESERVED,
        },
      });
      return { row, ownsLease: true, attempt };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await findOpenIntent(order.id);
    if (!concurrent) throw error;
    reservation = { row: concurrent, ownsLease: false, attempt: 0 };
  }

  if (!reservation.ownsLease) {
    const handled = await handleOpenIntent(
      {
        id: order.id,
        orderNumber: order.orderNumber,
        amountSar,
        currency,
        customerEmail: order.user?.email,
        customerName: order.user?.name ?? snapshot.data.fullName,
      },
      reservation.row,
      new Date(),
    );
    if (handled) return handled;
    throw new PaymentError("PROVIDER_FAILED", "تغيّرت نيّة الدفع بالتزامن");
  }

  return completeReservation(
    {
      id: order.id,
      orderNumber: order.orderNumber,
      amountSar,
      currency,
      customerEmail: order.user?.email,
      customerName: order.user?.name ?? snapshot.data.fullName,
    },
    reservation.row,
    reservation.attempt,
    selectedProvider.name,
    "none",
  );
}

interface PaymentOrderContext {
  id: string;
  orderNumber: string;
  amountSar: number;
  currency: string;
  customerEmail?: string;
  customerName?: string;
}

async function findOpenIntent(orderId: string) {
  return prisma.paymentIntent.findFirst({
    where: { orderId, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

function creationRef(
  paymentProvider: PaymentProviderName,
  orderId: string,
  attempt: number,
): string {
  return `creating_${paymentProvider}_${orderId}_${attempt}`;
}

function parseCreationRef(
  value: string,
): { provider: PaymentProviderName; orderId: string; attempt: number } | null {
  const match = /^creating_(manual|moyasar|tap)_(.+)_([1-9]\d{0,8})$/u.exec(value);
  if (!match || !isPaymentProviderName(match[1])) return null;
  const attempt = Number(match[3]);
  if (!Number.isSafeInteger(attempt)) return null;
  return { provider: match[1], orderId: match[2], attempt };
}

async function handleOpenIntent(
  order: PaymentOrderContext,
  existing: NonNullable<Awaited<ReturnType<typeof findOpenIntent>>>,
  now: Date,
): Promise<CreatedIntent | null> {
  const reservation = parseCreationRef(existing.providerRef);
  if (reservation) {
    if (
      reservation.orderId !== order.id ||
      reservation.provider !== existing.provider
    ) {
      await requireManualReview(order.id, "INVALID_CREATION_RESERVATION");
      throw new PaymentError("PROVIDER_FAILED", "حجز نيّة الدفع غير صالح");
    }

    if (existing.updatedAt > new Date(now.getTime() - CREATION_LEASE_MS)) {
      throw new PaymentError("PROVIDER_FAILED", "إنشاء نيّة الدفع جارٍ بالفعل");
    }

    if (
      reservation.provider === "tap" &&
      (existing.failureCode === CREATION_STARTED ||
        existing.failureCode === CREATION_AMBIGUOUS) &&
      now.getTime() - existing.createdAt.getTime() >= TAP_IDEMPOTENCY_RETRY_MS
    ) {
      await requireManualReview(order.id, "TAP_IDEMPOTENCY_WINDOW_EXPIRED");
      throw new PaymentError(
        "PROVIDER_FAILED",
        "انتهت نافذة استئناف إنشاء عملية Tap وتلزم المصالحة اليدوية",
      );
    }

    const recovery =
      reservation.provider === "moyasar" &&
      existing.failureCode !== CREATION_RESERVED &&
      existing.failureCode !== CREATION_RETRYABLE
        ? "reconcile-only"
        : "safe-retry";
    const claimed = await prisma.paymentIntent.updateMany({
      where: {
        id: existing.id,
        providerRef: existing.providerRef,
        status: existing.status,
        updatedAt: existing.updatedAt,
      },
      data: { failureCode: CREATION_RESERVED, failureMessage: null },
    });
    if (claimed.count === 0) {
      throw new PaymentError("PROVIDER_FAILED", "إنشاء نيّة الدفع جارٍ بالفعل");
    }
    return completeReservation(
      order,
      { ...existing, failureCode: CREATION_RESERVED, updatedAt: new Date() },
      reservation.attempt,
      reservation.provider,
      recovery,
    );
  }

  if (!isPaymentProviderName(existing.provider)) {
    await requireManualReview(order.id, "UNKNOWN_PAYMENT_PROVIDER");
    throw new PaymentError("PROVIDER_FAILED", "مزوّد النيّة المخزّن غير معروف");
  }

  if (
    !sameAmountAtTwoDecimals(Number(existing.amountSar), order.amountSar) ||
    normalizeCurrency(existing.currency) !== order.currency
  ) {
    await requireManualReview(order.id, "STORED_INTENT_FINANCIAL_MISMATCH");
    throw new PaymentError("PROVIDER_FAILED", "بيانات النيّة المالية لا تطابق الطلبية");
  }

  const checkoutUrl = validateStoredCheckoutUrl(
    existing.provider,
    existing.checkoutUrl,
  );
  if (checkoutUrl === undefined) {
    await requireManualReview(order.id, "UNSAFE_CHECKOUT_URL");
    throw new PaymentError("PROVIDER_FAILED", "رابط الدفع المخزّن غير موثوق");
  }

  if (existing.expiresAt && existing.expiresAt > now) {
    return {
      intentId: existing.id,
      providerRef: existing.providerRef,
      checkoutUrl,
      status: existing.status,
      amountSar: Number(existing.amountSar),
    };
  }

  if (existing.provider === "manual") {
    await prisma.paymentIntent.updateMany({
      where: { id: existing.id, status: existing.status },
      data: { status: "EXPIRED" },
    });
    return null;
  }

  // بوابة خارجية: لا نتيح محاولة جديدة حتى تقول البوابة إن الأولى نهائية.
  await reconcilePaymentIntent(existing.id);
  const refreshed = await prisma.paymentIntent.findUnique({
    where: { id: existing.id },
    select: { status: true },
  });
  if (refreshed?.status === "PAID") throw new PaymentError("ALREADY_PAID");
  if (refreshed?.status === "REFUNDED") {
    throw new PaymentError("ORDER_NOT_PAYABLE");
  }
  if (refreshed && OPEN_STATUSES.includes(refreshed.status)) {
    throw new PaymentError(
      "PROVIDER_FAILED",
      "لم يؤكد المزوّد انتهاء المحاولة السابقة بعد",
    );
  }
  return null;
}

/**
 * يجلب حالة النيّة من المزوّد نفسه قبل أي انتقال محلي نهائي.
 *
 * انتهاء مؤقّتنا المحلي ليس دليلًا على أن العميل لم يدفع: قد يكون webhook
 * ضاع أو تأخر. لذلك لا تتحول نيّة بوابة خارجية إلى EXPIRED بمجرد الساعة؛
 * المرجع الموثوق من API المزوّد هو الذي يقرر الحالة المالية.
 */
async function reconcilePaymentIntent(intentId: string): Promise<void> {
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: intentId },
    select: {
      provider: true,
      providerRef: true,
      status: true,
    },
  });

  if (!intent || !OPEN_STATUSES.includes(intent.status)) return;
  if (!isPaymentProviderName(intent.provider) || intent.provider === "manual") {
    return;
  }

  // المرجع المحلي المؤقت لا يمكن جلبه من API المزوّد. مسار الاستئناف
  // الخاص بالإنشاء يعالجه بعد انتهاء lease وبمفتاح الخمول المناسب.
  if (parseCreationRef(intent.providerRef)) return;

  const event = await PROVIDERS[intent.provider].retrieve(intent.providerRef);
  if (!event) return;
  if (
    event.provider !== intent.provider ||
    event.providerRef !== intent.providerRef
  ) {
    const row = await prisma.paymentIntent.findUnique({
      where: { id: intentId },
      select: { orderId: true },
    });
    if (row) await requireManualReview(row.orderId, "RECONCILIATION_REFERENCE_MISMATCH");
    return;
  }

  if (
    event.status === "PAID" ||
    event.status === "FAILED" ||
    event.status === "EXPIRED" ||
    event.status === "REFUNDED"
  ) {
    await settleIntent(event.providerRef, {
      status: event.status,
      provider: event.provider,
      failureCode: event.failureCode,
      failureMessage: event.failureMessage,
      amountSar: event.amountSar,
      currency: event.currency,
      payload: event.payload,
    });
  }
}

async function completeReservation(
  order: PaymentOrderContext,
  reservation: NonNullable<Awaited<ReturnType<typeof findOpenIntent>>>,
  attempt: number,
  paymentProvider: PaymentProviderName,
  recovery: "none" | "safe-retry" | "reconcile-only",
): Promise<CreatedIntent> {
  const selectedProvider = PROVIDERS[paymentProvider];
  const began = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE
    `;
    const currentOrder = await tx.order.findUnique({
      where: { id: order.id },
      select: { status: true, needsManualReview: true },
    });
    if (
      currentOrder?.status !== "PENDING_PAYMENT" ||
      currentOrder.needsManualReview
    ) {
      return false;
    }
    const marked = await tx.paymentIntent.updateMany({
      where: {
        id: reservation.id,
        providerRef: reservation.providerRef,
        status: { in: [...OPEN_STATUSES] },
      },
      data: { failureCode: CREATION_STARTED, failureMessage: null },
    });
    return marked.count === 1;
  });
  if (!began) throw new PaymentError("ORDER_NOT_PAYABLE");

  let providerIntent;
  try {
    providerIntent = await selectedProvider.create({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountSar: order.amountSar,
      currency: order.currency,
      customerEmail: order.customerEmail,
      customerName: order.customerName,
      returnUrl: new URL(
        `/pay/${encodeURIComponent(order.orderNumber)}`,
        env().STORE_PUBLIC_URL,
      ).toString(),
      expiresAt: reservation.expiresAt ?? new Date(
        Date.now() + env().PAYMENT_EXPIRY_MINUTES * 60 * 1000,
      ),
      attempt,
      recovery,
    });
  } catch (error) {
    const ambiguous = error instanceof PaymentError && error.ambiguous;
    await prisma.paymentIntent.updateMany({
      where: {
        id: reservation.id,
        providerRef: reservation.providerRef,
        status: { in: [...OPEN_STATUSES] },
      },
      data: {
        failureCode: ambiguous ? CREATION_AMBIGUOUS : CREATION_RETRYABLE,
        failureMessage: "تعذّر إكمال إنشاء العملية لدى مزوّد الدفع",
      },
    });
    if (paymentProvider === "moyasar" && recovery === "reconcile-only") {
      await requireManualReview(order.id, "MOYASAR_CREATE_AMBIGUOUS");
    }
    throw error;
  }

  if (
    providerIntent.providerRef.length === 0 ||
    providerIntent.providerRef.length > 160 ||
    !sameAmountAtTwoDecimals(providerIntent.amountSar, order.amountSar) ||
    normalizeCurrency(providerIntent.currency) !== order.currency
  ) {
    await requireManualReview(order.id, "INVALID_PROVIDER_CREATE_RESPONSE");
    throw new PaymentError(
      "PROVIDER_FAILED",
      "الإثبات المالي في استجابة المزوّد غير صالح",
      { ambiguous: true },
    );
  }

  const checkoutUrl = validateStoredCheckoutUrl(
    paymentProvider,
    providerIntent.checkoutUrl,
  );
  const isOpen = OPEN_STATUSES.includes(providerIntent.status);
  if (
    checkoutUrl === undefined ||
    (!isOpen && !FINAL_STATUSES.includes(providerIntent.status)) ||
    (paymentProvider !== "manual" && isOpen && checkoutUrl === null)
  ) {
    await requireManualReview(order.id, "INVALID_PROVIDER_CREATE_RESPONSE");
    throw new PaymentError(
      "PROVIDER_FAILED",
      "حالة أو رابط استجابة المزوّد غير صالح",
      { ambiguous: true },
    );
  }

  let finalizedStatus: PaymentStatus;
  try {
    finalizedStatus = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE
      `;
      const [currentOrder, currentIntent] = await Promise.all([
        tx.order.findUnique({
          where: { id: order.id },
          select: { status: true, needsManualReview: true },
        }),
        tx.paymentIntent.findUnique({
          where: { id: reservation.id },
          select: { status: true, providerRef: true },
        }),
      ]);
      if (!currentIntent || currentIntent.providerRef !== reservation.providerRef) {
        throw new PaymentError("PROVIDER_FAILED", "تغيّر حجز نيّة الدفع بالتزامن");
      }

      const mayRemainOpen =
        currentOrder?.status === "PENDING_PAYMENT" &&
        !currentOrder.needsManualReview &&
        OPEN_STATUSES.includes(currentIntent.status);
      const nextStatus =
        isOpen && mayRemainOpen ? providerIntent.status : currentIntent.status;
      const updated = await tx.paymentIntent.update({
        where: { id: reservation.id },
        data: {
          providerRef: providerIntent.providerRef,
          checkoutUrl,
          status: nextStatus,
          failureCode: null,
          failureMessage: null,
        },
        select: { status: true },
      });
      return updated.status;
    });
  } catch (error) {
    await requireManualReview(order.id, "PROVIDER_REFERENCE_CONFLICT");
    throw error;
  }

  if (FINAL_STATUSES.includes(providerIntent.status)) {
    await settleIntent(providerIntent.providerRef, {
      status: providerIntent.status as SettleOutcome["status"],
      provider: paymentProvider,
      amountSar: providerIntent.amountSar,
      currency: providerIntent.currency,
      payload: { source: "create-or-recovery-response" },
    });
    finalizedStatus = providerIntent.status;
  }

  if (!isOpen && providerIntent.status === "PAID") {
    return {
      intentId: reservation.id,
      providerRef: providerIntent.providerRef,
      checkoutUrl: null,
      status: "PAID",
      amountSar: providerIntent.amountSar,
    };
  }
  if (!isOpen) {
    return {
      intentId: reservation.id,
      providerRef: providerIntent.providerRef,
      checkoutUrl: null,
      status: finalizedStatus,
      amountSar: providerIntent.amountSar,
    };
  }
  if (!OPEN_STATUSES.includes(finalizedStatus)) {
    throw new PaymentError("ORDER_NOT_PAYABLE");
  }
  return {
    intentId: reservation.id,
    providerRef: providerIntent.providerRef,
    checkoutUrl,
    status: finalizedStatus,
    amountSar: providerIntent.amountSar,
  };
}

async function requireManualReview(orderId: string, reason: string): Promise<void> {
  console.error(`[payments] ${reason} للطلبية ${orderId}.`);
  await prisma.order.updateMany({
    where: { id: orderId },
    data: {
      needsManualReview: true,
      manualReviewCode: sanitizePaymentFailureCode(reason),
      manualReviewNote:
        "أوقفت طبقة الدفع المعالجة لأن إثباتًا أو مرجعًا ماليًا لم يجتز التحقق.",
      manualReviewOpenedAt: new Date(),
      manualReviewResolvedAt: null,
    },
  });
}

function validateStoredCheckoutUrl(
  paymentProvider: PaymentProviderName,
  value: string | null,
): string | null | undefined {
  if (paymentProvider === "manual") return value === null ? null : undefined;
  return validateCheckoutUrl(paymentProvider, value) ?? undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

/** آخر نيّة دفع على الطلبية — للعرض في صفحتي الدفع والإدارة. */
export async function getLatestIntent(orderId: string) {
  const intent = await prisma.paymentIntent.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
  if (!intent) return null;

  // هذه دالة قراءة للواجهة أيضًا. لا نسمح لصف قديم/معدّل يدويًا بتجاوز
  // التحقق الصارم الذي يطبّق وقت الإنشاء ثم الوصول إلى location.assign.
  const checkoutUrl = isPaymentProviderName(intent.provider)
    ? validateStoredCheckoutUrl(intent.provider, intent.checkoutUrl)
    : undefined;
  return {
    ...intent,
    checkoutUrl: checkoutUrl === undefined ? null : checkoutUrl,
  };
}

export interface SettleOutcome {
  status: Extract<PaymentStatus, "PAID" | "FAILED" | "EXPIRED" | "REFUNDED">;
  /** اسم المزوّد الذي تحقّق من الإشعار؛ يجب أن يطابق سجلّ النيّة. */
  provider: PaymentProviderName;
  failureCode?: string;
  failureMessage?: string;
  requiresManualReview?: boolean;
  /** الإثبات المالي إلزامي حتى لا تتحول حمولة ناقصة إلى نجاح. */
  amountSar: number;
  currency: string;
  payload?: unknown;
}

const PAYMENT_TRANSITIONS = {
  REQUIRES_ACTION: ["PENDING", "PAID", "FAILED", "EXPIRED"],
  PENDING: ["PAID", "FAILED", "EXPIRED"],
  // قد يصل نجاح موثّق متأخرًا بعد فشل/انتهاء محلي؛ نسجّله لأنه مال حقيقي.
  FAILED: ["PAID"],
  EXPIRED: ["PAID"],
  // لا شيء يخفض PAID، والاسترداد الكامل وحده ينتقل بها إلى REFUNDED.
  PAID: ["REFUNDED"],
  REFUNDED: [],
} as const satisfies Record<PaymentStatus, readonly PaymentStatus[]>;

/** جدول الحالة المغلق؛ تستعمله fixtures وتستعمله الكتابة الشرطية أدناه. */
export function canTransitionPaymentStatus(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return (PAYMENT_TRANSITIONS[from] as readonly PaymentStatus[]).includes(to);
}

/**
 * يسوّي نيّة دفع — الدالة الأخطر في هذا الملف.
 *
 * ⚠️ **يجب أن تكون خاملة (idempotent)**. الإشعار قد يصل مرتين، أو يصل
 * بعد أن أكّد المسؤول الدفع يدويًا، أو يصل من مصدرين معًا. وكل تسوية
 * ناجحة تستدعي `onPaymentSucceeded` التي تشتري من AliExpress — فتسويةٌ
 * مضاعفة تعني **شراء الطلبية مرتين بمال حقيقي**.
 *
 * الدفع والإلغاء يقفلان صف الطلبية أولًا ثم صف النيّة داخل معاملة واحدة.
 * بهذا لا توجد نافذة يسجّل فيها الإلغاء CANCELLED/EXPIRED بعد قراءة نجاح
 * الدفع وقبل كتابته. إذا سبق الإلغاء فعلًا، نسجّل المال PAID ونرفع الطلبية
 * للمراجعة/الاسترداد بدل إسقاط إشعار صحيح بصمت.
 */
export async function settleIntent(
  providerRef: string,
  outcome: SettleOutcome,
  options: { deferPostPayment?: boolean } = {},
): Promise<{ applied: boolean }> {
  if (
    !/^[^\u0000-\u001f\u007f-\u009f]{1,160}$/u.test(providerRef)
  ) {
    return { applied: false };
  }

  const safeFailureCode = sanitizePaymentFailureCode(outcome.failureCode);
  const safeFailureMessage = sanitizePaymentFailureMessage(
    outcome.failureMessage,
  );

  // نحتاج orderId لترتيب الأقفال فقط؛ كل قرار مالي يعاد تحت القفل أدناه.
  const located = await prisma.paymentIntent.findUnique({
    where: { providerRef },
    select: { id: true, orderId: true },
  });
  if (!located) return { applied: false };

  const decision = await prisma.$transaction(async (tx) => {
    // ترتيب موحّد مع cancelOrder: Order ثم PaymentIntent، لمنع deadlock.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order" WHERE "id" = ${located.orderId} FOR UPDATE
    `;
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PaymentIntent" WHERE "id" = ${located.id} FOR UPDATE
    `;

    const order = await tx.order.findUnique({
      where: { id: located.orderId },
      select: { status: true, needsManualReview: true },
    });
    const intent = await tx.paymentIntent.findUnique({
      where: { id: located.id },
      select: {
        orderId: true,
        providerRef: true,
        provider: true,
        status: true,
        amountSar: true,
        currency: true,
      },
    });
    if (!order || !intent || intent.providerRef !== providerRef) {
      return { applied: false, shouldProcess: false };
    }

    if (intent.provider !== outcome.provider) {
      await tx.order.update({
        where: { id: intent.orderId },
        data: {
          needsManualReview: true,
          manualReviewCode: "PROVIDER_MISMATCH",
          manualReviewNote: "مزوّد الإشعار لا يطابق مزوّد نيّة الدفع.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
      return {
        applied: false,
        shouldProcess: false,
        log: `PROVIDER_MISMATCH:${intent.orderId}`,
      };
    }

    const expectedCurrency = normalizeCurrency(intent.currency);
    const receivedCurrency = normalizeCurrency(outcome.currency);
    const amountMatches = sameAmountAtTwoDecimals(
      Number(intent.amountSar),
      outcome.amountSar,
    );
    if (
      !expectedCurrency ||
      !receivedCurrency ||
      expectedCurrency !== receivedCurrency ||
      !amountMatches
    ) {
      const reason =
        !expectedCurrency || !receivedCurrency
          ? "INVALID_FINANCIAL_PROOF"
          : expectedCurrency !== receivedCurrency
            ? "CURRENCY_MISMATCH"
            : outcome.status === "REFUNDED"
              ? "PARTIAL_OR_MISMATCHED_REFUND"
              : "AMOUNT_MISMATCH";
      const message =
        `expected ${Number(intent.amountSar)} ${intent.currency}; ` +
        `received ${Number.isFinite(outcome.amountSar) ? outcome.amountSar : "INVALID"} ${receivedCurrency ?? "INVALID"}`;
      const mayFail = canTransitionPaymentStatus(intent.status, "FAILED");
      await tx.paymentIntent.update({
        where: { id: located.id },
        data: {
          ...(mayFail ? { status: "FAILED" as const } : {}),
          failureCode: reason,
          failureMessage: message,
          lastWebhookPayload:
            outcome.payload === undefined
              ? undefined
              : (redactPayload(outcome.payload) as object),
        },
      });
      await tx.order.update({
        where: { id: intent.orderId },
        data: {
          needsManualReview: true,
          manualReviewCode: reason,
          manualReviewNote:
            "المبلغ أو العملة في الإثبات المالي لا يطابقان نيّة الدفع المحلية.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
      return {
        applied: false,
        shouldProcess: false,
        log: `${reason}:${intent.orderId}`,
      };
    }

    if (!canTransitionPaymentStatus(intent.status, outcome.status)) {
      if (outcome.requiresManualReview) {
        await tx.paymentIntent.update({
          where: { id: located.id },
          data: {
            failureCode:
              safeFailureCode ?? "PROVIDER_REVERSAL_REVIEW",
            failureMessage: safeFailureMessage,
            lastWebhookPayload:
              outcome.payload === undefined
                ? undefined
                : (redactPayload(outcome.payload) as object),
          },
        });
        await tx.order.update({
          where: { id: intent.orderId },
          data: {
            needsManualReview: true,
            manualReviewCode: "PROVIDER_REVERSAL_REVIEW",
            manualReviewNote:
              "وصل انعكاس مالي بعد حالة نهائية؛ يلزم التحقق من لوحة المزوّد.",
            manualReviewOpenedAt: new Date(),
            manualReviewResolvedAt: null,
          },
        });
        return {
          applied: true,
          shouldProcess: false,
          log: `PROVIDER_REVERSAL_REVIEW:${intent.orderId}`,
        };
      }
      return { applied: false, shouldProcess: false };
    }

    let shouldProcess = false;
    let paymentNeedsReview = false;
    if (outcome.status === "PAID") {
      const otherPaid = await tx.paymentIntent.count({
        where: {
          orderId: intent.orderId,
          status: "PAID",
          id: { not: located.id },
        },
      });
      shouldProcess =
        otherPaid === 0 &&
        !order.needsManualReview &&
        (order.status === "PENDING_PAYMENT" || order.status === "PAID");
      paymentNeedsReview = !shouldProcess;

      if (order.status === "PENDING_PAYMENT") {
        await tx.order.update({
          where: { id: intent.orderId },
          data: {
            status: "PAID",
            ...(paymentNeedsReview
              ? {
                  needsManualReview: true,
                  manualReviewCode: "PAID_STATE_CONFLICT",
                  manualReviewNote:
                    "وصل دفع صحيح لكن دفعة ناجحة أخرى تمنع التوريد الآلي.",
                  manualReviewOpenedAt: new Date(),
                  manualReviewResolvedAt: null,
                }
              : {}),
          },
        });
      } else if (paymentNeedsReview) {
        await tx.order.update({
          where: { id: intent.orderId },
          data: {
            needsManualReview: true,
            manualReviewCode: "PAID_STATE_CONFLICT",
            manualReviewNote:
              "وصل دفع صحيح لكن حالة الطلبية أو دفعة ناجحة أخرى تمنع التوريد الآلي.",
            manualReviewOpenedAt: new Date(),
            manualReviewResolvedAt: null,
          },
        });
      }
    } else if (outcome.status === "REFUNDED") {
      paymentNeedsReview = true;
      await tx.order.update({
        where: { id: intent.orderId },
        data: {
          needsManualReview: true,
          manualReviewCode: "UNEXPECTED_REFUND",
          manualReviewNote:
            "وصل تأكيد استرداد خارج طلب الاسترداد المحلي؛ يلزم ربطه والتحقق منه.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
    } else if (outcome.requiresManualReview) {
      paymentNeedsReview = true;
      await tx.order.update({
        where: { id: intent.orderId },
        data: {
          needsManualReview: true,
          manualReviewCode: "PAYMENT_PROVIDER_REVIEW",
          manualReviewNote:
            "أعاد مزوّد الدفع حالة تتطلب تحققًا بشريًا قبل متابعة الطلبية.",
          manualReviewOpenedAt: new Date(),
          manualReviewResolvedAt: null,
        },
      });
    }

    await tx.paymentIntent.update({
      where: { id: located.id },
      data: {
        status: outcome.status,
        failureCode: safeFailureCode,
        failureMessage: safeFailureMessage,
        ...(outcome.status === "PAID" ? { paidAt: new Date() } : {}),
        lastWebhookPayload:
          outcome.payload === undefined
            ? undefined
            : (redactPayload(outcome.payload) as object),
      },
    });

    // المهمة الدائمة جزء من معاملة إثبات الدفع نفسها. إذا سقطت النسخة بعد
    // commit وقبل الاتصال بـ AliExpress ستلتقطها دورة cron لاحقًا؛ وإذا
    // أعيد webhook فلن تنشأ مهمة ثانية بفضل المفتاح الفريد (orderId, kind).
    if (shouldProcess) {
      await enqueueSourceOrderJob(intent.orderId, tx);
    }

    return {
      applied: true,
      shouldProcess,
      log: paymentNeedsReview
        ? `${outcome.status === "REFUNDED" ? "REFUNDED" : "PAID_REVIEW"}:${intent.orderId}`
        : undefined,
    };
  });

  if (decision.log) {
    console.error(`[payments] ${decision.log}`);
  }
  if (decision.applied && decision.shouldProcess) {
    // الاتصال بالمورّد خارج المعاملة؛ أقفال المال لا تبقى أثناء الشبكة.
    // webhook يستطيع تأجيل المحاولة الأولى إلى after() ليقرّ للمزوّد
    // سريعًا، مع بقاء المهمة في PostgreSQL إن أوقفت المنصة التنفيذ الخلفي.
    if (!options.deferPostPayment) {
      await processSourceOrderJobs({ orderId: located.orderId, limit: 1 });
    }
  }

  return { applied: decision.applied };
}

/**
 * يستدرك الطلبيات المدفوعة العالقة.
 *
 * settleIntent تسوّي النيّة ثم تستدعي onPaymentSucceeded خارج المعاملة.
 * لو سقط الخادم بينهما بقيت النيّة والطلبية PAID — مدفوعة
 * ولم تُشترَ. تُستدعى هذه من المهمة المجدولة فتُعيد تشغيل ما بعد الدفع.
 * حدّ التقادم يتفادى مسابقة إشعار قيد المعالجة، والعملية خاملة بفضل حارس
 * صفوف AeOrder وكتابة markOrderPaid الشرطية.
 */
export async function recoverStrandedPaidIntents(): Promise<number> {
  return backfillRecoverableSourceJobs(25);
}

/**
 * تأكيد الدفع يدويًا من لوحة الإدارة.
 *
 * يمرّ عبر `settleIntent` لا بكتابة مباشرة، حتى يتشارك المزلاج نفسه:
 * لو وصل إشعار متأخّر بعد التأكيد اليدوي لَما اشترى الطلبية مرة ثانية.
 */
export async function confirmManualPayment(
  intentId: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<{ ok: boolean; message: string }> {
  /**
   * القاموس يُختار من اللغة المُمرَّرة لا من الكوكيز.
   *
   * `getDictionary` تقرأ الكوكيز، فتعمل داخل الطلب وحده وترمي في كل سياق
   * آخر — والمهمة المجدولة وسكربتات التحقق تستدعي هذه الطبقة خارج أي
   * طلب. هذا هو الاصطلاح نفسه المتّبع في lib/orders.ts و lib/cart-service.ts.
   */
  const t = dictionaries[locale];

  const intent = await prisma.paymentIntent.findUnique({
    where: { id: intentId },
    select: {
      providerRef: true,
      provider: true,
      status: true,
      amountSar: true,
      currency: true,
    },
  });

  if (!intent) return { ok: false, message: t.payment.notFound };
  if (intent.provider !== "manual") {
    return { ok: false, message: t.admin.paymentNotManual };
  }
  if (!OPEN_STATUSES.includes(intent.status)) {
    return { ok: false, message: t.payment.alreadyPaid };
  }

  const { applied } = await settleIntent(intent.providerRef, {
    status: "PAID",
    provider: "manual",
    amountSar: Number(intent.amountSar),
    currency: intent.currency,
    payload: { source: "admin-manual-confirmation" },
  });

  return applied
    ? { ok: true, message: t.admin.paymentConfirmed }
    : { ok: false, message: t.payment.alreadyPaid };
}

/**
 * ينهي مهلة النيّات المعلّقة.
 *
 * تُستدعى من المهمة المجدولة. الغرض ليس التنظيف بل التصحيح: نيّة معلّقة
 * إلى الأبد تمنع العميل من بدء محاولة جديدة (تُعاد له كما هي أعلاه)،
 * فتصير الطلبية غير قابلة للدفع بلا سبب ظاهر.
 */
export async function expireStaleIntents(): Promise<number> {
  const stale = await prisma.paymentIntent.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      expiresAt: { lt: new Date() },
    },
    orderBy: { expiresAt: "asc" },
    take: 100,
    select: {
      id: true,
      provider: true,
      providerRef: true,
      status: true,
      failureCode: true,
    },
  });

  let finalized = 0;
  for (const intent of stale) {
    const reservation = parseCreationRef(intent.providerRef);
    const safelyUnsentReservation =
      reservation &&
      (intent.failureCode === CREATION_RESERVED ||
        intent.failureCode === CREATION_RETRYABLE);

    if (intent.provider === "manual" || safelyUnsentReservation) {
      const changed = await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: intent.status },
        data: { status: "EXPIRED" },
      });
      finalized += changed.count;
      continue;
    }

    if (!isPaymentProviderName(intent.provider) || reservation) {
      // حجز إنشاء خارجي غامض يبقى محجوزًا حتى مسار الاستئناف/المراجعة؛
      // إعلان انتهائه قد يسمح بإنشاء عملية ثانية بينما الأولى حيّة.
      continue;
    }

    try {
      await reconcilePaymentIntent(intent.id);
      const after = await prisma.paymentIntent.findUnique({
        where: { id: intent.id },
        select: { status: true },
      });
      if (after && FINAL_STATUSES.includes(after.status)) finalized++;
    } catch (error) {
      // عطل المزوّد لا يبرر إنشاء محاولة مالية ثانية. نترك النيّة مفتوحة
      // لتعيد الدورة القادمة المصالحة، مع سجل خالٍ من الأسرار.
      console.error(
        `[payments] تعذّرت مصالحة النيّة المنتهية ${intent.id}:`,
        safeErrorKind(error),
      );
    }
  }

  return finalized;
}

/**
 * يحجب بيانات البطاقة قبل حفظ حمولة الإشعار.
 *
 * الحمولة تُحفظ للتشخيص، لكن حفظ رقم بطاقة أو رمز تحقّق — ولو جزئيًا —
 * يخرجنا من نطاق ما يجوز تخزينه. الحجب هنا بالمفتاح لأن أشكال المزوّدين
 * تختلف، والقائمة تلتقط الجذور المشتركة بينها.
 */
function redactPayload(value: unknown, depth = 0): unknown {
  const SENSITIVE = [
    "number",
    "card",
    "cvv",
    "cvc",
    "token",
    "secret",
    "pan",
    "expiry",
    "exp_month",
    "exp_year",
  ];

  if (depth >= 12) return "«محجوب: عمق زائد»";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactPayload(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) {
      if (k === "__proto__") continue;
      const lower = k.toLowerCase();
      out[k] = SENSITIVE.some((s) => lower.includes(s))
        ? "«محجوب»"
        : redactPayload(v, depth + 1);
    }
    return out;
  }
  return value;
}

export { PaymentError } from "./types";
export type {
  PaymentProviderName,
  PaymentProvider,
  WebhookEvent,
} from "./types";
