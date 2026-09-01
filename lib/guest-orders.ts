import { cookies } from "next/headers";
import { z } from "zod";
import { sign, unsign } from "@/lib/signed-cookie";

/**
 * ربط طلبيات الضيف بالمتصفّح الذي أنشأها.
 *
 * طلبية الضيف (userId = null) لا تملك صاحبًا مسجّلًا، فكان يمكن لأي شخص
 * يعرف رقم الطلبية قراءتها (ثغرة IDOR). الحل: عند إتمام الشراء نسجّل رقم
 * الطلبية في كوكي موقّع (httpOnly)، ولا تُعرض طلبية الضيف إلا لمن يحمل
 * رقمها في هذا الكوكي — أي المتصفّح الذي أنشأها فعلًا.
 */

const COOKIE = "ae_ds_guest";
const MAX = 20; // سقف أرقام الطلبيات المحفوظة في الكوكي
const MAX_AGE = 60 * 60 * 24 * 30; // 30 يومًا

const listSchema = z
  .array(z.string().regex(/^AE-\d{8}-[0-9A-F]{6}$/))
  .max(MAX);

async function read(): Promise<string[]> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  if (!raw) return [];

  const value = unsign(raw);
  if (!value) return [];

  try {
    const parsed = listSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** يسجّل طلبية ضيف كمملوكة لهذا المتصفّح. */
export async function rememberGuestOrder(orderNumber: string): Promise<void> {
  const list = await read();
  if (list.includes(orderNumber)) return;

  const next = [orderNumber, ...list].slice(0, MAX);
  const store = await cookies();
  store.set(COOKIE, sign(JSON.stringify(next)), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
}

/** هل أنشأ هذا المتصفّح طلبية الضيف المذكورة؟ */
export async function ownsGuestOrder(orderNumber: string): Promise<boolean> {
  return (await read()).includes(orderNumber);
}
