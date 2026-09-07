
import { env } from "@/lib/env";

export { formatSar } from "./format";

/**
 * محرّك التسعير.
 *
 * السبب في وجوده: **الريال السعودي غير مدعوم في واجهات AliExpress إطلاقًا**
 * (فحص التوثيق كاملًا: كلمة SAR لا ترد في قوائم العملة المستهدفة).
 * لذلك نجلب بالدولار ونحوّل محليًا، ونتحمّل نحن مخاطر سعر الصرف.
 *
 * ولهذا السبب أيضًا يُثبَّت سعر الصرف على الطلبية وقت إنشائها،
 * حتى لا تتغيّر الحسابات المالية بأثر رجعي.
 */

export interface PriceBreakdown {
  /** التكلفة بعملة المصدر (USD) */
  costSource: number;
  /** تكلفة الشحن بعملة المصدر */
  shippingSource: number;
  /** سعر الصرف المطبَّق شاملًا الهامش الاحتياطي */
  fxRate: number;
  /** سعر البيع قبل الضريبة بالريال */
  subtotalSar: number;
  /** الشحن بالريال */
  shippingSar: number;
  /** ضريبة القيمة المضافة بالريال */
  vatSar: number;
  /** الإجمالي المستحق على العميل بالريال */
  totalSar: number;
  /** هامش الربح المحقَّق بالريال */
  marginSar: number;
}

/**
 * سعر الصرف الفعّال = السعر الأساسي + هامش احتياطي لتقلّب الصرف ورسوم التحويل.
 *
 * ⚠️ هذه النسخة تقرأ من متغيّرات البيئة فقط وهي **الاحتياطي لا مصدر الحقيقة**.
 * مصدر الحقيقة هو `effectiveFxRateAsync` في lib/fx.ts (يقرأ جدول FxRate).
 * تبقى هذه الدالة متزامنة عمدًا: لها متصلون متزامنون (لوحة الإدارة،
 * وحساب المدى الافتراضي في المسارات التي لا تنتظر قاعدة بيانات)،
 * وتحويلها إلى async يتسلسل عبر كامل شجرة التسعير بلا مقابل.
 */
export function effectiveFxRate(): number {
  const cfg = env();
  return cfg.FX_USD_TO_SAR * (1 + cfg.FX_BUFFER_PERCENT / 100);
}

/**
 * يقرّب المبلغ إلى أقرب مضاعف للوحدة المحددة (0.05 افتراضيًا).
 *
 * الحساب يجري بالهللات كأعداد صحيحة عمدًا: الطريقة المباشرة
 * `Math.round(amount / step) * step` تنتج انحرافًا في الفاصلة العائمة
 * (مثلًا 247 × 0.05 = 12.350000000000001)، وهو غير مقبول في المبالغ المالية.
 */
export function roundPrice(amount: number, step?: number): number {
  const s = step ?? env().PRICE_ROUNDING;
  const cents = amount * 100;
  const stepCents = Math.round(s * 100);
  // s ≤ 0 أو خطوةٌ أصغر من نصف هللة (0 < s < 0.005) كلاهما يجعل stepCents
  // صفرًا؛ القسمة عليه تُنتج NaN فتصير كل الأسعار «ليست رقمًا». نتراجع إلى
  // التقريب إلى أقرب هللة بدل إنتاج سعر معطوب.
  if (s <= 0 || stepCents === 0) return Math.round(cents) / 100;
  return (Math.round(cents / stepCents) * stepCents) / 100;
}

/**
 * يحوّل مبلغًا من عملة المصدر إلى الريال بسعر صرف محدّد.
 * تمرير `fxRate` صراحةً ضروري عند إعادة حساب طلبية قديمة
 * حتى تُستخدم نسبة ذلك اليوم لا نسبة اليوم.
 */
export function toSar(amountSource: number, fxRate?: number): number {
  return amountSource * (fxRate ?? effectiveFxRate());
}

/** سعر بيع وحدة واحدة بالريال (شامل الهامش، قبل الضريبة). */
export function retailUnitPriceSar(
  costSource: number,
  opts: { marginPercent?: number; fxRate?: number } = {},
): number {
  const cfg = env();
  const margin = opts.marginPercent ?? cfg.DEFAULT_MARGIN_PERCENT;
  const sar = toSar(costSource, opts.fxRate);
  return roundPrice(sar * (1 + margin / 100));
}

export interface CartLineInput {
  /** تكلفة الوحدة بعملة المصدر */
  unitCostSource: number;
  quantity: number;
  /** تكلفة الشحن بعملة المصدر لهذا السطر */
  shippingCostSource: number;
  /**
   * هل رسوم الشحن شاملة ضريبة القيمة المضافة (حقل ddpIncludeVATTax).
   * تجاهله يعني احتساب الضريبة مرتين أو خسارتها.
   */
  shippingIncludesVat?: boolean;
  marginPercent?: number;
}

/**
 * يحسب التفصيل المالي الكامل لسلة.
 *
 * @param fxRate سعر صرف مثبّت — مرّره عند إعادة حساب طلبية قائمة
 */
export function calculateTotals(
  lines: CartLineInput[],
  fxRate?: number,
): PriceBreakdown {
  const cfg = env();
  const rate = fxRate ?? effectiveFxRate();

  let costSource = 0;
  let shippingSource = 0;
  let subtotalSar = 0;
  let shippingSar = 0;
  /** جزء الشحن الذي لم تُحتسب ضريبته بعد */
  let taxableShippingSar = 0;

  for (const line of lines) {
    const lineCost = line.unitCostSource * line.quantity;
    costSource += lineCost;
    shippingSource += line.shippingCostSource;

    const unitRetail = retailUnitPriceSar(line.unitCostSource, {
      marginPercent: line.marginPercent,
      fxRate: rate,
    });
    subtotalSar += unitRetail * line.quantity;

    const lineShipSar = roundPrice(toSar(line.shippingCostSource, rate));
    shippingSar += lineShipSar;
    if (!line.shippingIncludesVat) {
      taxableShippingSar += lineShipSar;
    }
  }

  subtotalSar = roundPrice(subtotalSar);
  shippingSar = roundPrice(shippingSar);

  // الضريبة على قيمة السلع + الشحن غير الشامل للضريبة
  const vatSar = roundPrice(
    (subtotalSar + taxableShippingSar) * (cfg.VAT_PERCENT / 100),
  );
  const totalSar = roundPrice(subtotalSar + shippingSar + vatSar);

  const totalCostSar = toSar(costSource + shippingSource, rate);
  const marginSar = roundPrice(subtotalSar + shippingSar - totalCostSar);

  return {
    costSource: round2(costSource),
    shippingSource: round2(shippingSource),
    fxRate: rate,
    subtotalSar,
    shippingSar,
    vatSar,
    totalSar,
    marginSar,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * تنسيق مبلغ بالريال السعودي.
 * تُستخدم الأرقام اللاتينية عمدًا في الحالتين لأنها العرف السائد في
 * المتاجر السعودية وأسهل في المسح البصري للأسعار.
 */
