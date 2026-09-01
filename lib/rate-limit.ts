/**
 * محدِّد معدّل بسيط في الذاكرة (نافذة ثابتة).
 *
 * الغرض: كبح إغراق المسارات والاستغلال التضخيمي وحشو بيانات الاعتماد.
 * يعمل لكل نسخة خادم على حدة، وهو كافٍ لنشر بنسخة واحدة. عند التوسّع
 * الأفقي انقل الحالة إلى مخزن مشترك (Redis) واضبط بروكسي عكسيًّا يمرّر
 * عنوان العميل الحقيقي.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** سقف حجم الخريطة — يمنع استنزاف الذاكرة عبر مفاتيح لا حصر لها. */
const MAX_BUCKETS = 50_000;

let lastSweep = 0;
function sweep(now: number): void {
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
}

/**
 * يضمن ألا تتجاوز الخريطة سقفها. ينظّف المنتهية أولًا، وإن بقيت فوق
 * السقف يمسح الخريطة كاملةً (فشل آمن: تصفير الحدود مؤقتًا أهون من نفاد
 * الذاكرة). يُستدعى قبل إنشاء سلّة جديدة.
 */
function ensureCapacity(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  sweep(now);
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

export interface RateResult {
  ok: boolean;
  retryAfter: number; // بالثواني
}

/**
 * حدّ يزيد العدّاد في كل استدعاء — للمحدِّد العام (proxy).
 */
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
): RateResult {
  const now = Date.now();
  if (now - lastSweep >= 60_000) sweep(now);

  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    ensureCapacity(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }

  if (b.count >= max) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }

  b.count++;
  return { ok: true, retryAfter: 0 };
}

// --- واجهة عدّ الإخفاقات (للمصادقة) ---------------------------------------
// تفصل «القراءة» عن «التسجيل» حتى نعدّ محاولات الدخول الفاشلة فقط ونصفّر
// العدّاد عند النجاح — فلا يُقفَل مستخدم شرعي نجح دخوله.

/** العدد الحالي للمفتاح (0 إن لا سلّة أو انتهت نافذتها). */
export function currentCount(key: string): number {
  const b = buckets.get(key);
  if (!b || Date.now() >= b.resetAt) return 0;
  return b.count;
}

/** يسجّل محاولة (يُنشئ السلّة أو يزيد العدّاد) — تُستدعى عند الإخفاق. */
export function recordHit(key: string, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    ensureCapacity(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  b.count++;
}

/** يصفّر عدّاد المفتاح — تُستدعى عند النجاح. */
export function clearKey(key: string): void {
  buckets.delete(key);
}
