import { NextResponse } from "next/server";
import { activeProvider, settleIntent } from "@/lib/payments";
import { manualProvider } from "@/lib/payments/manual";
import { moyasarProvider } from "@/lib/payments/moyasar";
import { tapProvider } from "@/lib/payments/tap";
import { rateLimit } from "@/lib/rate-limit";
import type { PaymentProvider } from "@/lib/payments/types";

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

const PROVIDERS: Record<string, PaymentProvider> = {
  manual: manualProvider,
  moyasar: moyasarProvider,
  tap: tapProvider,
};

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  /**
   * خنق خفيف بمفتاح المسار لا بعنوان العميل.
   *
   * المسار مستثنى من خنق `proxy.ts` عمدًا (وإلّا تقاسم الإشعارُ سلّةً
   * واحدة مع كل زائر بلا بروكسي)، لكن ترك المسار بلا أي حدّ يجعله بابًا
   * لإغراق قاعدة البيانات بمحاولات تحقّق فاشلة. السقف مرتفع كي لا يصطدم
   * به تدفّق إشعارات مشروع.
   */
  const { ok, retryAfter } = rateLimit("payments:webhook", 600, 60_000);
  if (!ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const provider = PROVIDERS[activeProvider()];

  // المزوّد اليدوي لا يملك إشعارات — لا نكشف حتى أن المسار قائم له
  if (!provider || provider.name === "manual") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const rawBody = await request.text();

  let event;
  try {
    event = await provider.verifyWebhook(request, rawBody);
  } catch (e) {
    console.error("[payments] خطأ أثناء التحقق من الإشعار:", e);
    return NextResponse.json({ error: "INVALID" }, { status: 401 });
  }

  // فشل التحقق يُردّ بـ 401 بلا تفصيل: الردّ لا يعلّم المهاجم شيئًا عن
  // مدى اقترابه من توقيع صحيح.
  if (!event) {
    return NextResponse.json({ error: "INVALID" }, { status: 401 });
  }

  // الحالات غير النهائية لا تُسوّى — تصل إشعارات وسيطة كثيرة، وتسويتها
  // بحالة PENDING كانت ستحرق مزلاج الخمول قبل وصول النتيجة الفعلية.
  if (
    event.status !== "PAID" &&
    event.status !== "FAILED" &&
    event.status !== "EXPIRED" &&
    event.status !== "REFUNDED"
  ) {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  try {
    await settleIntent(event.providerRef, {
      status: event.status,
      failureCode: event.failureCode,
      failureMessage: event.failureMessage,
      // المبلغ المأخوذ فعلًا — تقارنه التسوية بمبلغ النيّة قبل الشراء
      amountSar: event.amountSar,
      payload: event.payload,
    });
  } catch (e) {
    // خطأ عندنا لا عند المزوّد: نعيد 500 كي تعيد البوابة المحاولة، لأن
    // الطلبية مدفوعة فعلًا ويجب أن تُصدَّر.
    console.error("[payments] تعذّرت تسوية الإشعار:", e);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }

  return NextResponse.json(
    { received: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
