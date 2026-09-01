/**
 * محدِّد معدّل بسيط في الذاكرة (نافذة ثابتة).
 *
 * الغرض: كبح إغراق المسارات والاستغلال التضخيمي (سلة مزوّرة تولّد عشرات
 * الاستدعاءات) وحشو بيانات الاعتماد. يعمل لكل نسخة خادم على حدة، وهو
 * كافٍ لنشر بنسخة واحدة. عند التوسّع الأفقي انقل الحالة إلى مخزن مشترك
 * (Redis) واضبط بروكسي عكسيًّا يمرّر عنوان العميل الحقيقي.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// تنظيف دوري للسلال المنتهية حتى لا تنمو الخريطة بلا حدّ
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
}

export interface RateResult {
  ok: boolean;
  retryAfter: number; // بالثواني
}

export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
): RateResult {
  const now = Date.now();
  sweep(now);

  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }

  if (b.count >= max) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }

  b.count++;
  return { ok: true, retryAfter: 0 };
}
