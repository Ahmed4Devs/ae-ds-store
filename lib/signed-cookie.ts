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

function purposeKey(purpose: string): Buffer {
  // اشتقاق مفتاح مستقل لكل نوع كوكي يمنع نقل توقيع صالح من سياق إلى آخر.
  return createHmac("sha256", secret())
    .update(`ae-ds-store/cookie/${purpose}/v1`)
    .digest();
}

function calculateMac(versionedPayload: string, purpose: string): string {
  return createHmac("sha256", purposeKey(purpose))
    .update(versionedPayload)
    .digest("base64url");
}

// Browsers normally cap one cookie near 4 KiB, but raw HTTP clients are not
// obliged to. Reject before base64 decoding to avoid attacker-sized buffers.
const MAX_SIGNED_COOKIE_CHARS = 4_096;
const MAX_PAYLOAD_CHARS = 4_048;
const SHA256_BASE64URL_CHARS = 43;

export function sign(value: string, purpose: string): string {
  const payload = Buffer.from(value, "utf8").toString("base64url");
  const versionedPayload = `v1.${payload}`;
  const mac = calculateMac(versionedPayload, purpose);
  const signed = `${versionedPayload}.${mac}`;
  if (signed.length > MAX_SIGNED_COOKIE_CHARS) {
    throw new RangeError("Signed cookie exceeds the supported size");
  }
  return signed;
}

/** يعيد القيمة الأصلية إن صحّ التوقيع، وإلا null. */
export function unsign(signed: string, purpose: string): string | null {
  if (signed.length === 0 || signed.length > MAX_SIGNED_COOKIE_CHARS) {
    return null;
  }
  const parts = signed.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  const [version, payload, mac] = parts;
  if (
    payload.length === 0 ||
    payload.length > MAX_PAYLOAD_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(payload) ||
    mac.length !== SHA256_BASE64URL_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(mac)
  ) {
    return null;
  }
  const versionedPayload = `${version}.${payload}`;
  const expected = calculateMac(versionedPayload, purpose);

  const a = Buffer.from(mac, "base64url");
  const b = Buffer.from(expected, "base64url");
  // Node's base64 decoder is deliberately forgiving. Enforce canonical
  // encoding so junk suffixes cannot create alternate accepted signatures.
  if (a.toString("base64url") !== mac) return null;
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  try {
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }
}
