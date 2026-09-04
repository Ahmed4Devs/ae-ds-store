import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { DEFAULT_LOCALE, dictionaries, type Locale } from "@/lib/i18n/shared";
import { onPaymentSucceeded } from "@/lib/orders";
import type { PaymentStatus } from "@/lib/generated/prisma/enums";
import { manualProvider } from "./manual";
import { moyasarProvider } from "./moyasar";
import { tapProvider } from "./tap";
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
      totalSar: true,
      user: { select: { email: true, name: true } },
      shippingSnapshot: true,
      _count: { select: { payments: true } },
    },
  });

  if (!order) throw new PaymentError("ORDER_NOT_FOUND");

  if (order.status === "PAID" || order.status === "SOURCED") {
    throw new PaymentError("ALREADY_PAID");
  }
  if (order.status !== "PENDING_PAYMENT") {
    // ملغاة أو مشحونة أو قيد التوريد — لا معنى لدفع جديد عليها
    throw new PaymentError("ORDER_NOT_PAYABLE");
  }

  // نيّة مفتوحة قائمة تُعاد كما هي بدل إنشاء ثانية: العميل الذي حدّث
  // الصفحة لا يجب أن يولّد سلسلة نيّات معلّقة تُربك المطابقة اليدوية.
  const existing = await prisma.paymentIntent.findFirst({
    where: { orderId, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });

  if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
    return {
      intentId: existing.id,
      providerRef: existing.providerRef,
      checkoutUrl: existing.checkoutUrl,
      status: existing.status,
      amountSar: Number(existing.amountSar),
    };
  }

  const amountSar = Number(order.totalSar);
  const expiresAt = new Date(
    Date.now() + env().PAYMENT_EXPIRY_MINUTES * 60 * 1000,
  );
  const snapshot = order.shippingSnapshot as { fullName?: string } | null;

  const intent = await provider().create({
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountSar,
    customerEmail: order.user?.email,
    customerName: order.user?.name ?? snapshot?.fullName,
    returnUrl: `${env().STORE_PUBLIC_URL}/pay/${order.orderNumber}`,
    expiresAt,
    attempt: order._count.payments + 1,
  });

  const row = await prisma.paymentIntent.create({
    data: {
      orderId: order.id,
      provider: provider().name,
      providerRef: intent.providerRef,
      status: intent.status,
      amountSar,
      currency: env().STORE_CURRENCY,
      checkoutUrl: intent.checkoutUrl,
      expiresAt,
    },
    select: { id: true },
  });

  return {
    intentId: row.id,
    providerRef: intent.providerRef,
    checkoutUrl: intent.checkoutUrl,
    status: intent.status,
    amountSar,
  };
}

/** آخر نيّة دفع على الطلبية — للعرض في صفحتي الدفع والإدارة. */
export async function getLatestIntent(orderId: string) {
  return prisma.paymentIntent.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
}

export interface SettleOutcome {
  status: Extract<PaymentStatus, "PAID" | "FAILED" | "EXPIRED" | "REFUNDED">;
  failureCode?: string;
  failureMessage?: string;
  /** المبلغ المأخوذ فعلًا لدى المزوّد بالريال — يُقارَن بمبلغ النيّة. */
  amountSar?: number;
  payload?: unknown;
}

/** فرق مقبول بين المبلغين — يمتصّ اختلاف التقريب بين الهللات والريالات. */
const AMOUNT_EPSILON = 0.01;

/**
 * يسوّي نيّة دفع — الدالة الأخطر في هذا الملف.
 *
 * ⚠️ **يجب أن تكون خاملة (idempotent)**. الإشعار قد يصل مرتين، أو يصل
 * بعد أن أكّد المسؤول الدفع يدويًا، أو يصل من مصدرين معًا. وكل تسوية
 * ناجحة تستدعي `onPaymentSucceeded` التي تشتري من AliExpress — فتسويةٌ
 * مضاعفة تعني **شراء الطلبية مرتين بمال حقيقي**.
 *
 * الحماية ليست قراءةً ثم كتابةً (تسابق بين الاثنين) بل كتابةٌ شرطية
 * واحدة: `updateMany` بشرط أن الحالة ليست PAID بعد. عدد الصفوف المتأثّرة
 * هو الحكم: صفر يعني أن غيرنا سبقنا فلا نفعل شيئًا.
 */
export async function settleIntent(
  providerRef: string,
  outcome: SettleOutcome,
): Promise<{ applied: boolean }> {
  const intent = await prisma.paymentIntent.findUnique({
    where: { providerRef },
    select: { id: true, orderId: true, status: true, amountSar: true },
  });

  if (!intent) return { applied: false };

  /**
   * التحقق من المبلغ قبل التسوية.
   *
   * التوقيع يثبت أن الإشعار من المزوّد، لكنه لا يثبت أن المبلغ المأخوذ
   * يساوي المستحق: خصمٌ جزئي (تفويض ثم التقاط جزء) أو تهيئة خاطئة قد
   * يُسوّي طلبيةً بريال واحد. فنرفض تسوية PAID إن اختلف المبلغ عن النيّة،
   * ونعلّمها FAILED مع سبب صريح لمراجعة بشرية بدل شراء ما لم يُدفع ثمنه.
   */
  if (
    outcome.status === "PAID" &&
    outcome.amountSar != null &&
    Math.abs(outcome.amountSar - Number(intent.amountSar)) > AMOUNT_EPSILON
  ) {
    console.error(
      `[payments] مبلغ الإشعار (${outcome.amountSar}) يخالف مبلغ النيّة (${Number(
        intent.amountSar,
      )}) للطلبية ${intent.orderId} — لم تُسوَّ.`,
    );
    await prisma.paymentIntent.updateMany({
      where: { providerRef, status: { notIn: ["PAID", "REFUNDED"] } },
      data: {
        status: "FAILED",
        failureCode: "AMOUNT_MISMATCH",
        failureMessage: `expected ${Number(intent.amountSar)} got ${outcome.amountSar}`,
      },
    });
    return { applied: false };
  }

  /**
   * الاسترداد استثناء على المزلاج.
   *
   * المزلاج العام يرفض أي تسوية بعد PAID (يمنع الشراء المزدوج)، لكن
   * الاسترداد **يأتي بعد** الدفع بطبيعته. فنسمح بانتقال PAID→REFUNDED
   * وحده عبر كتابة شرطية ثانية، ونُبقي paidAt كما هو (لا نصفّره) حفاظًا
   * على لحظة الدفع الأصلية، ونُعلم السجلّ ليراجع المسؤول طلبيةً رُدّ مالها.
   */
  if (outcome.status === "REFUNDED") {
    const refunded = await prisma.paymentIntent.updateMany({
      where: { providerRef, status: "PAID" },
      data: {
        status: "REFUNDED",
        lastWebhookPayload:
          outcome.payload === undefined
            ? undefined
            : (redactPayload(outcome.payload) as object),
      },
    });
    if (refunded.count > 0) {
      console.error(
        `[payments] رُدّ مبلغ الطلبية ${intent.orderId} — تلزم مراجعة إدارية.`,
      );
      return { applied: true };
    }
    // لم تكن مدفوعة بعد — تسقط إلى المسار العام أدناه (REQUIRES_ACTION→REFUNDED نادر)
  }

  const changed = await prisma.paymentIntent.updateMany({
    // الشرط هو المزلاج: المدفوعة لا تُسوّى مرة أخرى بأي حالة
    where: { providerRef, status: { not: "PAID" } },
    data: {
      status: outcome.status,
      failureCode: outcome.failureCode ?? null,
      failureMessage: outcome.failureMessage?.slice(0, 500) ?? null,
      paidAt: outcome.status === "PAID" ? new Date() : null,
      lastWebhookPayload:
        outcome.payload === undefined
          ? undefined
          : (redactPayload(outcome.payload) as object),
    },
  });

  if (changed.count === 0) return { applied: false };

  if (outcome.status === "PAID") {
    /**
     * حارس الخصم المزدوج عبر نيّتين.
     *
     * الفهرس الجزئي يمنع نيّتين **مفتوحتين** معًا، لكن نيّةً قديمة انتهت
     * ثم دُفعت لدى المزوّد قد تصل بعد أن سُوّيت نيّة أحدث للطلبية نفسها.
     * إن كانت الطلبية مدفوعةً بنيّة أخرى، لا نشتري ثانيةً بل نعلّم هذه
     * للاسترداد — العميل خُصم منه مرتين ويجب ردّ إحداهما.
     */
    const otherPaid = await prisma.paymentIntent.count({
      where: {
        orderId: intent.orderId,
        status: "PAID",
        providerRef: { not: providerRef },
      },
    });
    if (otherPaid > 0) {
      console.error(
        `[payments] الطلبية ${intent.orderId} دُفعت بأكثر من نيّة — تلزم مراجعة الاسترداد.`,
      );
      return { applied: true };
    }

    // خارج أي معاملة قاعدة بيانات: هذه الخطوة تستدعي شبكة خارجية وتطول،
    // وحجزُ معاملة خلالها يقفل صفوفًا لثوانٍ بلا داعٍ.
    await onPaymentSucceeded(intent.orderId);
  }

  return { applied: true };
}

/**
 * يستدرك الطلبيات المدفوعة العالقة.
 *
 * settleIntent تسوّي النيّة ثم تستدعي onPaymentSucceeded خارج المعاملة.
 * لو سقط الخادم بينهما بقيت النيّة PAID والطلبية PENDING_PAYMENT — مدفوعة
 * ولم تُشترَ. تُستدعى هذه من المهمة المجدولة فتُعيد تشغيل ما بعد الدفع.
 * حدّ التقادم يتفادى مسابقة إشعار قيد المعالجة، والعملية خاملة بفضل حارس
 * صفوف AeOrder وكتابة markOrderPaid الشرطية.
 */
export async function recoverStrandedPaidIntents(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const stranded = await prisma.paymentIntent.findMany({
    where: {
      status: "PAID",
      paidAt: { lt: cutoff },
      order: { status: "PENDING_PAYMENT" },
    },
    select: { orderId: true },
  });

  let recovered = 0;
  for (const row of stranded) {
    await onPaymentSucceeded(row.orderId);
    recovered++;
  }
  return recovered;
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
    select: { providerRef: true, provider: true, status: true },
  });

  if (!intent) return { ok: false, message: t.payment.notFound };
  if (intent.provider !== "manual") {
    return { ok: false, message: t.admin.paymentNotManual };
  }
  if (intent.status === "PAID") {
    return { ok: false, message: t.payment.alreadyPaid };
  }

  const { applied } = await settleIntent(intent.providerRef, {
    status: "PAID",
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
  const res = await prisma.paymentIntent.updateMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  return res.count;
}

/**
 * يحجب بيانات البطاقة قبل حفظ حمولة الإشعار.
 *
 * الحمولة تُحفظ للتشخيص، لكن حفظ رقم بطاقة أو رمز تحقّق — ولو جزئيًا —
 * يخرجنا من نطاق ما يجوز تخزينه. الحجب هنا بالمفتاح لأن أشكال المزوّدين
 * تختلف، والقائمة تلتقط الجذور المشتركة بينها.
 */
function redactPayload(value: unknown): unknown {
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

  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__") continue;
      const lower = k.toLowerCase();
      out[k] = SENSITIVE.some((s) => lower.includes(s))
        ? "«محجوب»"
        : redactPayload(v);
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
