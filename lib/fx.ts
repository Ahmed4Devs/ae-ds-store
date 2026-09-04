import { cache } from "react";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * سعر صرف الدولار مقابل الريال — مصدر الحقيقة لمسارات الطلب.
 *
 * قبل هذه الوحدة كان السعر يأتي من متغيّر بيئة فقط، فتغييره يستلزم
 * إعادة نشر كاملة بينما سعر التحويل الفعلي لدى البنك يتحرّك أسبوعيًا.
 * الآن يُسجَّل في جدول FxRate ويُقرأ منه، ويبقى متغيّر البيئة شبكة أمان
 * لا أكثر (راجع effectiveFxRate في lib/pricing — تبقى متزامنة عمدًا).
 *
 * الجدول **سجلّ تاريخي لا صف إعدادات**: كل تغيير يُضاف صفًا جديدًا،
 * لأن الطلبيات القائمة تحتفظ بالسعر المثبَّت عليها في fxRateUsed
 * والتعديل بأثر رجعي كان سيُفسد تدقيق الربحية.
 */

const BASE_CURRENCY = "USD";
const QUOTE_CURRENCY = "SAR";

/**
 * الحد الأدنى والأقصى المقبولان لسعر الصرف.
 * الريال مربوط بالدولار عند 3.75 منذ عقود، فأي قيمة خارج هذا النطاق
 * هي خطأ إدخال لا سعر — و«375» بدل «3.75» تعني تسعير الكتالوج كله
 * بمئة ضعف قبل أن ينتبه أحد.
 */
const MIN_RATE = 1;
const MAX_RATE = 10;

/** يُرمى عند رفض سعر خارج النطاق المعقول — يترجمه المتصل إلى رسالة للمستخدم. */
export class FxRateRangeError extends Error {
  constructor(rate: number) {
    super(`سعر صرف خارج النطاق المقبول (${MIN_RATE}–${MAX_RATE}): ${rate}`);
    this.name = "FxRateRangeError";
  }
}

/**
 * أحدث سعر مسجَّل، أو قيمة البيئة إن كان الجدول فارغًا.
 *
 * القراءة داخل try/catch عمدًا: تعثّر قاعدة البيانات يجب أن يخفض التسعير
 * إلى قيمة البيئة لا أن يُسقط صفحة المنتج والسلة معها.
 *
 * ومغلّفة بـ cache() لأن عرض صفحة واحدة يستدعيها من التسعير ومن الكتالوج
 * ومن السلة — بدون التغليف يتحوّل ذلك إلى عشرات الاستعلامات المتطابقة.
 */
export const currentFxRate = cache(async (): Promise<number> => {
  const fallback = env().FX_USD_TO_SAR;

  try {
    const row = await prisma.fxRate.findFirst({
      where: { baseCurrency: BASE_CURRENCY, quoteCurrency: QUOTE_CURRENCY },
      orderBy: { createdAt: "desc" },
      select: { rate: true },
    });

    if (!row) return fallback;

    // Decimal من Prisma — يلزم تحويله قبل أي عملية حسابية
    const rate = Number(row.rate);
    return Number.isFinite(rate) && rate > 0 ? rate : fallback;
  } catch (e) {
    console.error("[fx] تعذّرت قراءة سعر الصرف من قاعدة البيانات:", e);
    return fallback;
  }
});

/** السعر الفعّال = المسجَّل + الهامش الاحتياطي لتقلّب الصرف ورسوم التحويل. */
export async function effectiveFxRateAsync(): Promise<number> {
  const rate = await currentFxRate();
  return rate * (1 + env().FX_BUFFER_PERCENT / 100);
}

/**
 * يسجّل سعرًا جديدًا. إضافة دائمًا — لا تحديث (الجدول سجلّ).
 * يتحقّق من النطاق قبل الكتابة لأن الخطأ هنا يمرّ إلى كل سعر في المتجر.
 */
export async function recordFxRate(rate: number, source: string): Promise<void> {
  if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
    throw new FxRateRangeError(rate);
  }

  await prisma.fxRate.create({
    data: {
      baseCurrency: BASE_CURRENCY,
      quoteCurrency: QUOTE_CURRENCY,
      rate,
      source: source.trim() || "manual",
    },
  });
}

/** آخر الأسعار المسجَّلة — للعرض في لوحة الإعدادات. */
export async function fxHistory(
  limit = 10,
): Promise<Array<{ rate: number; source: string; createdAt: Date }>> {
  try {
    const rows = await prisma.fxRate.findMany({
      where: { baseCurrency: BASE_CURRENCY, quoteCurrency: QUOTE_CURRENCY },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { rate: true, source: true, createdAt: true },
    });

    return rows.map((r) => ({
      rate: Number(r.rate),
      source: r.source,
      createdAt: r.createdAt,
    }));
  } catch (e) {
    // السجلّ عرض إضافي — غيابه لا يبرّر إسقاط صفحة الإعدادات
    console.error("[fx] تعذّرت قراءة سجلّ أسعار الصرف:", e);
    return [];
  }
}
