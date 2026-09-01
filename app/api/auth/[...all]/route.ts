import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { currentCount, recordHit, clearKey } from "@/lib/rate-limit";

/**
 * معالج المصادقة مع خنق لكل بريد.
 *
 * تحديد المعدّل المبني على IP يُهزَم بتزوير X-Forwarded-For على خادم مكشوف
 * مباشرةً. الحل المناعي: نخنق المسارات الحسّاسة حسب البريد المستهدَف لا
 * حسب IP — فتدوير الترويسة لا يجدي لأن المفتاح هو الحساب نفسه.
 *
 * نقطتان حاسمتان تعلّمناهما من التحقق الخصمي:
 *   1) يجب استخراج البريد أيًّا كانت صيغة الجسم (JSON أو form-urlencoded أو
 *      multipart) لأن better-auth يقبلها جميعًا؛ قراءة JSON وحدها كانت
 *      تُتيح تجاوز الخنق بإرسال الاعتماد بصيغة form.
 *   2) نعدّ المحاولات الفاشلة فقط ونصفّر عند النجاح، فلا يُقفَل مستخدم
 *      شرعي نجح دخوله.
 */

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

// المسار (نسبةً إلى /api/auth) → (أقصى إخفاقات، النافذة بالمللي ثانية)
const RULES: Record<string, { max: number; windowMs: number }> = {
  "/sign-in/email": { max: 10, windowMs: 15 * 60_000 },
  "/sign-up/email": { max: 5, windowMs: 60 * 60_000 },
  "/forget-password": { max: 5, windowMs: 60 * 60_000 },
  "/request-password-reset": { max: 5, windowMs: 60 * 60_000 },
};

/** يستخرج البريد من الجسم أيًّا كانت صيغته (لا يعتمد على Content-Type وحده). */
async function extractEmail(req: Request): Promise<string | null> {
  const pick = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : null;

  let text: string;
  try {
    text = await req.clone().text();
  } catch {
    return null;
  }
  if (!text) return null;

  // JSON
  try {
    const body = JSON.parse(text);
    const e = pick(body?.email);
    if (e) return e;
  } catch {
    // ليست JSON — نجرّب صيغة النماذج
  }

  // application/x-www-form-urlencoded (أو أي جسم بصيغة مفتاح=قيمة)
  try {
    const e = pick(new URLSearchParams(text).get("email"));
    if (e) return e;
  } catch {
    // تجاهل
  }

  return null;
}

export async function POST(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/^.*\/api\/auth/, "");
  const rule = RULES[path];

  if (!rule) return handlers.POST(req);

  const email = await extractEmail(req);
  // إن تعذّر استخراج بريد على مسار محميّ (جسم مشوَّه/غير متوقَّع) نخنق على
  // مفتاح عام للمسار حتى لا يصير غياب البريد ثغرة تجاوز.
  const key = `auth:${path}:${email ?? "∅"}`;

  if (currentCount(key) >= rule.max) {
    return NextResponse.json(
      { message: "Too many attempts. Please try again later.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  const res = await handlers.POST(req);

  // نعدّ الفشل فقط؛ النجاح يصفّر العدّاد فلا يُقفَل من نجح دخوله
  if (res.status >= 200 && res.status < 300) {
    clearKey(key);
  } else {
    recordHit(key, rule.windowMs);
  }

  return res;
}
