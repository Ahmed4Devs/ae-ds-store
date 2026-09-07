import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/db";
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
const COOKIE_PURPOSE = "guest-orders";
const MAX = 20; // سقف أرقام الطلبيات المحفوظة في الكوكي
const MAX_AGE = 60 * 60 * 24 * 30; // 30 يومًا

const payloadSchema = z.object({
  version: z.literal(1),
  audience: z.literal(COOKIE_PURPOSE),
  entries: z
    .array(
      z.object({
        orderNumber: z.string().regex(/^AE-\d{8}-[0-9A-F]{6}$/),
        accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        expiresAt: z.number().int().positive(),
      }),
    )
    .max(MAX),
});

type GuestOrderEntry = z.infer<typeof payloadSchema>["entries"][number];

async function read(): Promise<GuestOrderEntry[]> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  if (!raw) return [];

  const value = unsign(raw, COOKIE_PURPOSE);
  if (!value) return [];

  try {
    const parsed = payloadSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return [];
    const now = Date.now();
    return parsed.data.entries.filter((entry) => entry.expiresAt > now);
  } catch {
    return [];
  }
}

/** يسجّل طلبية ضيف كمملوكة لهذا المتصفّح. */
export async function rememberGuestOrder(
  orderNumber: string,
  accessToken: string,
): Promise<void> {
  const list = await read();
  if (list.some((entry) => entry.orderNumber === orderNumber)) return;

  const next = [
    { orderNumber, accessToken, expiresAt: Date.now() + MAX_AGE * 1000 },
    ...list,
  ].slice(0, MAX);
  const store = await cookies();
  store.set(
    COOKIE,
    sign(
      JSON.stringify({
        version: 1,
        audience: COOKIE_PURPOSE,
        entries: next,
      }),
      COOKIE_PURPOSE,
    ),
    {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === "production",
    },
  );
}

/** هل أنشأ هذا المتصفّح طلبية الضيف المذكورة؟ */
export async function ownsGuestOrder(orderNumber: string): Promise<boolean> {
  const entry = (await read()).find((item) => item.orderNumber === orderNumber);
  if (!entry) return false;

  const guestAccessHash = createHash("sha256")
    .update(entry.accessToken)
    .digest("base64url");
  const order = await prisma.order.findFirst({
    where: {
      orderNumber,
      userId: null,
      guestAccessHash,
      guestAccessExpiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return Boolean(order);
}
