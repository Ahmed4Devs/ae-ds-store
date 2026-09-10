/**
 * محدِّد معدّل متزامن خلف واجهة تخزين صغيرة.
 *
 * التنفيذ الافتراضي محلي لكل نسخة خادم. الواجهة مقصودة كي يمكن استبداله
 * لاحقًا بمخزن موزّع من دون تغيير المنادين، لكن هذا الملف لا يجلب شبكة ولا
 * يعتمد على Redis. حدود التطبيق تظل طبقة امتصاص محلية؛ حدّ Vercel/WAF هو
 * الطبقة الموزعة عند التوسّع الأفقي.
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
 * يضمن ألا تتجاوز الخريطة سقفها. إذا ظلت ممتلئة بعد تنظيف المنتهي نفشل
 * مغلقًا للمفتاح الجديد ولا نطرد سلّة قائمة: الإخلاء يجعل تدوير مفاتيح
 * المهاجم زرًا يمحو حدود زوار آخرين، والبحث الخطي عن ضحية يخلق CPU DoS.
 */
function hasCapacity(now: number): boolean {
  if (buckets.size < MAX_BUCKETS) return true;
  // لا نكنس 50 ألف مدخل لكل مفتاح جديد عند الامتلاء؛ مرة في الدقيقة فقط.
  if (now - lastSweep >= 60_000) sweep(now);
  return buckets.size < MAX_BUCKETS;
}

export interface RateResult {
  ok: boolean;
  retryAfter: number; // بالثواني
  remaining: number;
  resetAt: number;
}

/**
 * عقد التخزين الذي تعتمد عليه طبقة الخنق. التنفيذ الموزع مستقبلًا يستطيع
 * تطبيق العقد نفسه مع عملية ذرّية واحدة لكل دالة.
 */
export interface RateLimitStore {
  consume(key: string, max: number, windowMs: number, cost?: number): RateResult;
  current(key: string): number;
  record(key: string, windowMs: number): void;
  clear(key: string): void;
}

class MemoryRateLimitStore implements RateLimitStore {
  consume(
    key: string,
    max: number,
    windowMs: number,
    cost = 1,
  ): RateResult {
    const now = Date.now();
    const units = Number.isSafeInteger(cost) && cost > 0 ? cost : 1;
    if (now - lastSweep >= 60_000) sweep(now);

    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      const resetAt = now + windowMs;
      if (!hasCapacity(now)) {
        return {
          ok: false,
          retryAfter: Math.max(1, Math.ceil(windowMs / 1000)),
          remaining: 0,
          resetAt,
        };
      }
      const count = Math.min(max, units);
      buckets.set(key, { count, resetAt });
      return {
        ok: units <= max,
        retryAfter: units <= max ? 0 : Math.ceil(windowMs / 1000),
        remaining: Math.max(0, max - count),
        resetAt,
      };
    }

    if (bucket.count + units > max) {
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        remaining: 0,
        resetAt: bucket.resetAt,
      };
    }

    bucket.count += units;
    return {
      ok: true,
      retryAfter: 0,
      remaining: Math.max(0, max - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  current(key: string): number {
    const bucket = buckets.get(key);
    if (!bucket || Date.now() >= bucket.resetAt) return 0;
    return bucket.count;
  }

  record(key: string, windowMs: number): void {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (!hasCapacity(now)) return;
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    bucket.count++;
  }

  clear(key: string): void {
    buckets.delete(key);
  }
}

const store: RateLimitStore = new MemoryRateLimitStore();

/**
 * حدّ يزيد العدّاد في كل استدعاء — للمحدِّد العام (proxy).
 */
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
  cost = 1,
): RateResult {
  return store.consume(key, max, windowMs, cost);
}

// --- واجهة عدّ الإخفاقات (للمصادقة) ---------------------------------------
// تفصل «القراءة» عن «التسجيل» حتى نعدّ محاولات الدخول الفاشلة فقط ونصفّر
// العدّاد عند النجاح — فلا يُقفَل مستخدم شرعي نجح دخوله.

/** العدد الحالي للمفتاح (0 إن لا سلّة أو انتهت نافذتها). */
export function currentCount(key: string): number {
  return store.current(key);
}

/** يسجّل محاولة (يُنشئ السلّة أو يزيد العدّاد) — تُستدعى عند الإخفاق. */
export function recordHit(key: string, windowMs: number): void {
  store.record(key, windowMs);
}

/** يصفّر عدّاد المفتاح — تُستدعى عند النجاح. */
export function clearKey(key: string): void {
  store.clear(key);
}
