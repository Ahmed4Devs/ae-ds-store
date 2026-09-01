import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * توقيع الكوكيز غير الحسّاسة بـ HMAC-SHA256.
 *
 * السبب: الكوكيز التي يقرأها الخادم ويثق بمحتواها (السلة، قائمة طلبيات
 * الضيف) قابلة للتزوير من العميل ما لم تُوقَّع. httpOnly يمنع قراءة
 * JavaScript لها لكنه لا يمنع صياغتها يدويًا في طلب HTTP. التوقيع يضمن
 * أن القيمة صادرة عن الخادم ولم تُعدَّل.
 *
 * القيمة تُرمَّز base64url أولًا حتى لا تحوي نقطة تُربك الفصل عن التوقيع،
 * والمقارنة تتم بزمن ثابت تفاديًا لهجمات التوقيت.
 */

function secret(): string {
  return env().BETTER_AUTH_SECRET;
}

export function sign(value: string): string {
  const payload = Buffer.from(value, "utf8").toString("base64url");
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/** يعيد القيمة الأصلية إن صحّ التوقيع، وإلا null. */
export function unsign(signed: string): string | null {
  const dot = signed.indexOf(".");
  if (dot < 0) return null;

  const payload = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  try {
    return Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
}
