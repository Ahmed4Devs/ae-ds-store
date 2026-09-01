import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

/**
 * تحديد المعدّل على مستوى التطبيق (اصطلاح proxy في Next 16، بديل middleware).
 *
 * يغطّي مسارات API (عدا /api/auth الذي تتولّاه better-auth بحدّها الخاص)
 * وServer Actions (تُرسل ترويسة Next-Action) والمسارات الثقيلة (السلة،
 * إتمام الشراء، خيارات الشحن). يمنع إغراق المسارات والاستغلال التضخيمي.
 *
 * تنبيه نشر: هذا الخادم يقرأ عنوان العميل من X-Forwarded-For، وهي ترويسة
 * يزوّرها العميل ما لم يضبطها بروكسي عكسي موثوق. في الإنتاج ضع بروكسي
 * (nginx/caddy) يمسح أي XFF وارد ويضبطه من العنوان الحقيقي.
 */

function clientKey(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff
    ? xff.split(",")[0]?.trim()
    : (req.headers.get("x-real-ip") ?? "");
  return ip || "unknown";
}

export function proxy(req: NextRequest): NextResponse {
  const path = req.nextUrl.pathname;

  // better-auth يفرض حدّه الخاص على مسارات المصادقة
  if (path.startsWith("/api/auth")) return NextResponse.next();

  const isAction = req.headers.has("next-action");
  const isHeavy =
    path === "/api/shipping" ||
    path === "/cart" ||
    path === "/checkout" ||
    isAction;

  const group = isHeavy ? "heavy" : "api";
  const max = isHeavy ? 30 : 120; // في الدقيقة
  const { ok, retryAfter } = rateLimit(
    `${clientKey(req)}:${group}`,
    max,
    60_000,
  );

  if (!ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/cart", "/checkout", "/product/:path*"],
};
