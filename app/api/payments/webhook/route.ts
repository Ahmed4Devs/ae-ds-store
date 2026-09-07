import { NextResponse } from "next/server";
import { settleIntent } from "@/lib/payments";
import { moyasarProvider } from "@/lib/payments/moyasar";
import { tapProvider } from "@/lib/payments/tap";
import { rateLimit } from "@/lib/rate-limit";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * إشعار بوابة الدفع (webhook).
 *
 * ثلاث خصائص تحكم تصميم هذا المسار، وكلّها مقصودة:
 *
 * 1. **يُقرأ الجسم خامًا قبل تحليله.** التحقق من التوقيع يجري على البايتات
 *    كما وصلت؛ وأي تحليل ثم إعادة ترميز يغيّرها (ترتيب المفاتيح، المسافات)
 *    فيفشل توقيع صحيح.
 *
 * 2. **الإشعار المكرّر يُردّ عليه بـ 200 لا بخطأ.** البوابات تعيد المحاولة
 *    على أي ردّ غير 2xx. فلو أعدنا 409 لتكرارٍ اكتشفناه، لَاستمرّت البوابة
 *    ترسل الإشعار نفسه دوريًا إلى الأبد. الخمول محسوم في settleIntent،
 *    ودورُنا هنا الإقرار بالاستلام.
 *
 * 3. **لا يُعاد أي شيء من الحمولة في الردّ.** الردّ سطر واحد ثابت، فلا
 *    يصير المسار مرآةً تُعيد ما يُرسله إليه.
 */

const PROVIDERS = [moyasarProvider, tapProvider] as const;
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415);
  }

  let rawBody: string;
  try {
    rawBody = await readWebhookBody(request);
  } catch (error) {
    const status = error instanceof WebhookBodyError ? error.status : 400;
    return json({ error: status === 413 ? "BODY_TOO_LARGE" : "INVALID_BODY" }, status);
  }

  // لا نربط المسار بالمزوّد النشط اليوم: إشعار نيّة قديمة يبقى صالحًا بعد
  // تبديل PAYMENT_PROVIDER، ويُحسم التطابق النهائي باسم المزوّد في السجلّ.
  let event = null;
  let verificationUnavailable = false;
  for (const provider of PROVIDERS) {
    try {
      event = await provider.verifyWebhook(request, rawBody);
      if (event) break;
    } catch (error) {
      verificationUnavailable = true;
      console.error(
        `[payments] تعذّر التحقق عبر ${provider.name}:`,
        safeErrorKind(error),
      );
    }
  }

  // فشل التحقق يُردّ بـ 401 بلا تفصيل: الردّ لا يعلّم المهاجم شيئًا عن
  // مدى اقترابه من توقيع صحيح.
  if (!event) {
    // عطل شبكة أثناء جلب فاتورة Moyasar الموثوقة يجب أن يعاد، لا أن يبدو
    // توقيعًا خاطئًا فتسقط البوابة الإشعار المالي نهائيًا.
    return json(
      { error: verificationUnavailable ? "VERIFY_UNAVAILABLE" : "INVALID" },
      verificationUnavailable ? 503 : 401,
    );
  }

  // الخنق بعد التوقيع ومفتاحه المرجع نفسه: جسم مزوّر لا يستطيع استنفاد
  // سلّة كل الإشعارات المشروعة، وإعادة مرجع واحد لا تحجب بقية الدفعات.
  const { ok, retryAfter } = rateLimit(
    `payments:webhook:${event.provider}:${event.providerRef}`,
    60,
    60_000,
  );
  if (!ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // الحالات غير النهائية لا تُسوّى — تصل إشعارات وسيطة كثيرة، وتسويتها
  // بحالة PENDING كانت ستحرق مزلاج الخمول قبل وصول النتيجة الفعلية.
  if (
    event.status !== "PAID" &&
    event.status !== "FAILED" &&
    event.status !== "EXPIRED" &&
    event.status !== "REFUNDED"
  ) {
    return json({ received: true }, 200);
  }

  try {
    await settleIntent(event.providerRef, {
      status: event.status,
      provider: event.provider,
      failureCode: event.failureCode,
      failureMessage: event.failureMessage,
      requiresManualReview: event.requiresManualReview,
      // المبلغ المأخوذ فعلًا — تقارنه التسوية بمبلغ النيّة قبل الشراء
      amountSar: event.amountSar,
      currency: event.currency,
      payload: event.payload,
    });
  } catch (e) {
    // خطأ عندنا لا عند المزوّد: نعيد 500 كي تعيد البوابة المحاولة، لأن
    // الطلبية مدفوعة فعلًا ويجب أن تُصدَّر.
    console.error(
      "[payments] تعذّرت تسوية الإشعار:",
      safeErrorKind(e),
    );
    return json({ error: "INTERNAL" }, 500);
  }

  return json({ received: true }, 200);
}

function json(body: object, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

class WebhookBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super(`WEBHOOK_BODY_${status}`);
  }
}

/** قراءة خام محدودة؛ لا نستخدم request.json لأن Tap توقّع الحقول الخام. */
async function readWebhookBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared != null) {
    if (!/^\d+$/u.test(declared)) throw new WebhookBodyError(400);
    if (Number(declared) > MAX_WEBHOOK_BODY_BYTES) {
      throw new WebhookBodyError(413);
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new WebhookBodyError(408)),
      WEBHOOK_BODY_TIMEOUT_MS,
    );
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        throw new WebhookBodyError(413);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel("invalid webhook body").catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
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
    throw new WebhookBodyError(400);
  }
}
