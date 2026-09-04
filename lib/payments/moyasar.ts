import { env } from "@/lib/env";
import type { PaymentStatus } from "@/lib/generated/prisma/enums";
import {
  PaymentError,
  secretMatches,
  type CreateIntentInput,
  type PaymentProvider,
  type ProviderIntent,
  type WebhookEvent,
} from "./types";

/**
 * بوابة Moyasar — مدى والبطاقات الائتمانية.
 *
 * استُدعيت بـ fetch مباشرةً لا بحزمة رسمية: الواجهة هنا ثلاثة طلبات بسيطة،
 * وإضافة اعتمادية لأجلها تزيد سطح التحديث بلا مقابل.
 */

const API = "https://api.moyasar.com/v1";

export const moyasarProvider: PaymentProvider = {
  name: "moyasar",

  async create(input: CreateIntentInput): Promise<ProviderIntent> {
    const res = await fetch(`${API}/invoices`, {
      method: "POST",
      headers: {
        Authorization: basicAuth(env().MOYASAR_SECRET_KEY),
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
        amount: Math.round(input.amountSar * 100),
        currency: env().STORE_CURRENCY,
        description: `طلبية ${input.orderNumber}`,
        callback_url: input.returnUrl,
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

    const payload: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        `Moyasar HTTP ${res.status}: ${describe(payload)}`,
      );
    }

    const invoice = payload as MoyasarInvoice | null;
    if (!invoice?.id) {
      throw new PaymentError("PROVIDER_FAILED", "استجابة Moyasar بلا معرّف فاتورة");
    }

    return {
      providerRef: invoice.id,
      checkoutUrl: invoice.url ?? null,
      status: mapStatus(invoice.status),
    };
  },

  async verifyWebhook(req, rawBody): Promise<WebhookEvent | null> {
    /**
     * تتحقق Moyasar من هوية الإشعار بسرّ مشترك تُرسله في الحمولة، لا
     * بتوقيع HMAC على الجسم. لذلك نقارن السرّ بزمن ثابت ونرفض ما لا
     * يطابق — والمقارنة العادية تسرّب طول التطابق عبر زمن التنفيذ.
     */
    let body: MoyasarWebhook | null = null;
    try {
      body = JSON.parse(rawBody) as MoyasarWebhook;
    } catch {
      return null;
    }

    const expected = env().PAYMENT_WEBHOOK_SECRET;
    const presented =
      body?.secret_token ?? req.headers.get("x-moyasar-token") ?? "";

    if (!secretMatches(presented, expected)) return null;

    const data = body?.data;
    const ref = data?.invoice_id || data?.id;
    if (!ref) return null;

    const status = mapStatus(data?.status);

    return {
      providerRef: ref,
      status,
      failureCode: data?.source?.message ? "DECLINED" : undefined,
      failureMessage: data?.source?.message ?? undefined,
      // المبلغ يعود بالهللات كما أُرسل — نحوّله إلى ريالات لتقارنه التسوية
      // بمبلغ النيّة (خصم جزئي أو حمولة معدَّلة لا يُسوّي الطلبية كاملة).
      amountSar:
        typeof data?.amount === "number" ? data.amount / 100 : undefined,
      currency: data?.currency,
      payload: body,
    };
  },
};

function basicAuth(secretKey: string): string {
  // المفتاح السري اسمُ المستخدم وكلمة المرور فارغة — كما ينص توثيق Moyasar
  return `Basic ${Buffer.from(`${secretKey}:`, "utf8").toString("base64")}`;
}

/** ترجمة حالات المزوّد إلى حالاتنا. ما لا نعرفه يبقى «قيد التأكيد» لا فاشلًا. */
function mapStatus(raw: string | undefined): PaymentStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "paid":
    case "captured":
      return "PAID";
    case "failed":
    case "declined":
    case "voided":
      return "FAILED";
    case "expired":
      return "EXPIRED";
    case "refunded":
      return "REFUNDED";
    case "initiated":
    case "pending":
      return "PENDING";
    default:
      return "PENDING";
  }
}

function describe(payload: unknown): string {
  if (!payload) return "بلا جسم";
  try {
    return JSON.stringify(payload).slice(0, 300);
  } catch {
    return "جسم غير قابل للترميز";
  }
}

interface MoyasarInvoice {
  id?: string;
  url?: string;
  status?: string;
}

interface MoyasarWebhook {
  secret_token?: string;
  data?: {
    id?: string;
    invoice_id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    source?: { message?: string };
  };
}
