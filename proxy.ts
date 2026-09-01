import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

/**
 * تحديد المعدّل على مستوى التطبيق (اصطلاح proxy في Next 16، بديل middleware).
 *
 * يغطّي: كل Server Actions أيًّا كانت الصفحة المستضيفة (تُرسل ترويسة
 * Next-Action) — بما فيها إجراءات الإدارة والتفضيلات — ومسارات API (عدا
 * /api/auth الذي تتولّاه better-auth بخنقها الخاص) وصفحتَي السلة وإتمام
 * الشراء الثقيلتين. صفحات التصفّح العادية لا تُخنَق حتى لا يتعطّل التنقّل.
 *
 * تنبيه نشر: عنوان العميل يُقرأ من X-Forwarded-For، وهي ترويسة يزوّرها
 * العميل ما لم يضبطها بروكسي عكسي موثوق. على خادم مكشوف مباشرةً يُهزَم
 * هذا الخنق بتدوير الترويسة؛ في الإنتاج ضع بروكسي (nginx/caddy) يمسح أي
 * XFF وارد ويضبطه من العنوان الحقيقي. هذا الخنق طبقة دفاع لا حلٌّ كامل.
 */

function clientKey(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff
    ? xff.split(",")[0]?.trim()
    : (req.headers.get("x-real-ip") ?? "");
  return ip || "unknown";
}

function limitOrPass(req: NextRequest, group: string, max: number): NextResponse {
  const { ok, retryAfter } = rateLimit(`${clientKey(req)}:${group}`, max, 60_000);
  if (!ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  return NextResponse.next();
}

export function proxy(req: NextRequest): NextResponse {
  const path = req.nextUrl.pathname;

  // better-auth يفرض خنقه الخاص على مسارات المصادقة
  if (path.startsWith("/api/auth")) return NextResponse.next();

  // Server Action على أي صفحة — أثقل مجموعة (يشمل إجراءات الإدارة والتفضيلات)
  if (req.headers.has("next-action")) return limitOrPass(req, "heavy", 30);

  // مسارات API
  if (path.startsWith("/api/")) {
    const heavy = path === "/api/shipping";
    return limitOrPass(req, heavy ? "heavy" : "api", heavy ? 30 : 120);
  }

  // صفحتان ثقيلتان تُعيدان تجميع السلة من المصدر
  if (path === "/cart" || path === "/checkout") {
    return limitOrPass(req, "heavy", 30);
  }

  // صفحات عادية — بلا خنق
  return NextResponse.next();
}

export const config = {
  // يشمل كل المسارات عدا أصول Next الثابتة، ليغطّي Server Actions على أي صفحة
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
