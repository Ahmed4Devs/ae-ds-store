import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import type { PaymentStatus } from "@/lib/generated/prisma/enums";
import {
  PaymentError,
  type CreateIntentInput,
  type PaymentProvider,
  type ProviderIntent,
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

export const tapProvider: PaymentProvider = {
  name: "tap",

  async create(input: CreateIntentInput): Promise<ProviderIntent> {
    const res = await fetch(`${API}/charges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env().TAP_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // بالريالات كعدد عشري — لا هللات (راجع التعليق أعلى الملف)
        amount: Number(input.amountSar.toFixed(2)),
        currency: env().STORE_CURRENCY,
        description: `طلبية ${input.orderNumber}`,
        // مرجعنا يعود في الإشعار فنطابق به بلا تخمين
        reference: { order: input.orderNumber },
        customer: {
          first_name: input.customerName || "عميل",
          ...(input.customerEmail ? { email: input.customerEmail } : {}),
        },
        source: { id: "src_all" },
        redirect: { url: input.returnUrl },
        post: { url: `${env().STORE_PUBLIC_URL}/api/payments/webhook` },
        // مهلة صفحة الدفع لدى المزوّد نفسها، فلا تبقى فاتورة حيّة قابلة
        // للدفع بعد أن تنتهي نيّتنا محليًّا (يمنع الخصم المزدوج).
        transaction: {
          expiry: { period: env().PAYMENT_EXPIRY_MINUTES, type: "MINUTE" },
        },
      }),
      cache: "no-store",
    });

    const payload: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      throw new PaymentError(
        "PROVIDER_FAILED",
        `Tap HTTP ${res.status}: ${describe(payload)}`,
      );
    }

    const charge = payload as TapCharge | null;
    if (!charge?.id) {
      throw new PaymentError("PROVIDER_FAILED", "استجابة Tap بلا معرّف عملية");
    }

    return {
      providerRef: charge.id,
      checkoutUrl: charge.transaction?.url ?? null,
      status: mapStatus(charge.status),
    };
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
    let body: TapCharge | null = null;
    try {
      body = JSON.parse(rawBody) as TapCharge;
    } catch {
      return null;
    }

    if (!body?.id) return null;

    const presented = req.headers.get("hashstring") ?? "";
    if (!hashMatches(body, presented)) return null;

    return {
      providerRef: body.id,
      status: mapStatus(body.status),
      failureCode: body.response?.code,
      failureMessage: body.response?.message,
      // المبلغ المأخوذ فعلًا — تقارنه التسوية بمبلغ النيّة
      amountSar: typeof body.amount === "number" ? body.amount : undefined,
      currency: body.currency,
      payload: body,
    };
  },
};

/**
 * يتحقق من توقيع Tap (hashstring) بإعادة بناء السلسلة الموثّقة والمقارنة
 * بزمن ثابت. الترتيب والبادئات (`x_id` … `x_created`) كما ينصّ التوثيق،
 * والمبلغ منسَّق لخانتين عشريتين (دقّة الريال).
 */
function hashMatches(charge: TapCharge, presented: string): boolean {
  const secret = env().TAP_SECRET_KEY;
  if (!secret || !presented) return false;

  const amount =
    typeof charge.amount === "number" ? charge.amount.toFixed(2) : "";
  const base =
    `x_id${charge.id ?? ""}` +
    `x_amount${amount}` +
    `x_currency${charge.currency ?? ""}` +
    `x_gateway_reference${charge.reference?.gateway ?? ""}` +
    `x_payment_reference${charge.reference?.payment ?? ""}` +
    `x_status${charge.status ?? ""}` +
    `x_created${charge.transaction?.created ?? ""}`;

  const expected = createHmac("sha256", secret).update(base).digest("hex");

  // حراسة الطول قبل timingSafeEqual: يرمي عند اختلاف الأطوال بدل أن يعيد false
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** ترجمة حالات المزوّد إلى حالاتنا. ما لا نعرفه يبقى «قيد التأكيد» لا فاشلًا. */
function mapStatus(raw: string | undefined): PaymentStatus {
  switch ((raw ?? "").toUpperCase()) {
    case "CAPTURED":
    case "PAID":
      return "PAID";
    case "DECLINED":
    case "FAILED":
    case "CANCELLED":
    case "VOID":
      return "FAILED";
    case "EXPIRED":
    case "TIMEDOUT":
      return "EXPIRED";
    case "REFUNDED":
      return "REFUNDED";
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

interface TapCharge {
  id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  reference?: { gateway?: string; payment?: string };
  transaction?: { url?: string; created?: string };
  response?: { code?: string; message?: string };
}
