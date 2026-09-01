import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

/**
 * معالج المصادقة مع خنق لكل بريد.
 *
 * تحديد المعدّل المبني على عنوان IP وحده يُهزَم بتزوير X-Forwarded-For على
 * خادم مكشوف مباشرةً. الحل المناعي: نخنق محاولات المسارات الحسّاسة حسب
 * البريد المستهدَف لا حسب IP — فتدوير الترويسة لا يجدي لأن المفتاح هو
 * الحساب نفسه. حدّ better-auth يبقى طبقةً ثانية.
 */

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

// المسار (نسبةً إلى /api/auth) → (أقصى محاولات، النافذة بالمللي ثانية)
const RULES: Record<string, { max: number; windowMs: number }> = {
  "/sign-in/email": { max: 10, windowMs: 10 * 60_000 },
  "/sign-up/email": { max: 5, windowMs: 60 * 60_000 },
  "/forget-password": { max: 5, windowMs: 60 * 60_000 },
  "/request-password-reset": { max: 5, windowMs: 60 * 60_000 },
};

export async function POST(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/^.*\/api\/auth/, "");
  const rule = RULES[path];

  if (rule) {
    // نقرأ نسخة من الجسم حتى يبقى الأصل سليمًا للمعالج
    const body = await req
      .clone()
      .json()
      .catch(() => null);
    const email =
      body && typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : null;

    if (email) {
      const { ok, retryAfter } = rateLimit(
        `auth:${path}:${email}`,
        rule.max,
        rule.windowMs,
      );
      if (!ok) {
        return NextResponse.json(
          {
            message: "Too many attempts. Please try again later.",
            code: "RATE_LIMITED",
          },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        );
      }
    }
  }

  return handlers.POST(req);
}
