import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { syncActiveOrders } from "@/lib/order-sync";
import { processSourceOrderJobs } from "@/lib/order-jobs";
import { expireStaleIntents, recoverStrandedPaidIntents } from "@/lib/payments";
import { processRefundRequests } from "@/lib/refunds";
import { purgeExpiredSecurityState } from "@/lib/security-retention";

/**
 * المدخل المجدول لمزامنة الطلبيات.
 *
 * واجهات AliExpress بلا إشعارات فورية، فبدون مهمة دورية تتجمّد حالة الطلبية
 * وتتبّعها إلى أن يفتح العميل صفحته أو يضغط المسؤول زرًّا يدويًا. هذا المسار
 * هو ما يستدعيه المجدول.
 *
 * يُقبل GET و POST لأن المجدولات تختلف: Vercel Cron يرسل GET بينما ترسل
 * أدوات أخرى POST.
 */

// المسار يقرأ الترويسات ويكتب في قاعدة البيانات، فلا يجوز أن يُحسَّن ساكنًا.
export const dynamic = "force-dynamic";
// أسوأ محاولة توريد قد تعيد تسعير عشرة أسطر ثم تنشئ الطلب لدى المورد.
// تعلن المهلة للمنصة بدل الاعتماد على افتراضها الافتراضي القصير.
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** مقارنة بزمن ثابت — timingSafeEqual يرمي عند اختلاف الأطوال فنحرسه أولًا. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** السرّ لا يُقبل في URL كي لا يظهر في سجلّات الطلب أو التاريخ أو التحليلات. */
function presentedSecret(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(auth);
  return match?.[1] ?? "";
}

async function handle(request: Request): Promise<NextResponse> {
  const expected = env().CRON_SECRET;

  // سرّ فارغ = المسار معطَّل، لا مفتوح. مسار مجدول بلا حماية يتيح لأي زائر
  // استدعاءه بلا حدّ فيستنزف حصة استدعاءات المنصّة ويوقف المتجر كلّه؛
  // ولذلك نعيد 404 حتى لا نكشف أصلًا أن المسار موجود.
  if (!expected) {
    return NextResponse.json(
      { error: "NOT_FOUND" },
      { status: 404, headers: NO_STORE },
    );
  }

  // استجابة واحدة للسرّ الخاطئ وللسرّ الغائب — أي تمييز بينهما يُخبر
  // المتطفّل أنه على الطريق الصحيح.
  if (!secretMatches(presentedSecret(request), expected)) {
    return NextResponse.json(
      { error: "UNAUTHORIZED" },
      { status: 401, headers: NO_STORE },
    );
  }

  // تبدأ الأعمال المالية الحرجة مع الاستقصاء، فلا تؤخرها عشرات اتصالات
  // AliExpress المتسلسلة. الدفعات محافظة لأن الاستدعاء الواحد قد ينتظر
  // مهلة المزوّد؛ الدورات التالية تلتقط البقية بترتيب FIFO.
  const [
    sync,
    expiredIntents,
    recoveredIntents,
    retention,
    sourceJobs,
    refundJobs,
  ] = await Promise.all([
    syncActiveOrders(3),
    expireStaleIntents(),
    // استدراك الطلبيات المدفوعة العالقة: نيّة سُوّيت PAID لكن سقط الخادم قبل
    // شرائها. المهمة الدورية هي شبكة الأمان التي تُعيد تشغيل ما بعد الدفع.
    recoverStrandedPaidIntents(),
    // جلسات/رموز/قدرات منتهية وسجلات AliExpress الأقدم من سياسة الاحتفاظ.
    purgeExpiredSecurityState(),
    processSourceOrderJobs({ limit: 1 }),
    processRefundRequests({ limit: 3 }),
  ]);

  return NextResponse.json(
    {
      polled: sync.polled,
      updated: sync.updated,
      errors: sync.errors,
      expiredIntents,
      recoveredIntents,
      sourceJobs,
      refundJobs,
      retention,
    },
    { headers: NO_STORE },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
