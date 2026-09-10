import { getProduct, getShippingOptions, AeApiError } from "@/lib/aliexpress";
import { calculateTotals, formatSar, retailUnitPriceSar, toSar } from "@/lib/pricing";
import { effectiveFxRateAsync } from "@/lib/fx";
import { prisma } from "@/lib/db";
import { deliveryEstimateAr } from "@/lib/ksa";
import type { Cart } from "@/lib/cart";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/shared";
import { safeErrorKind } from "@/lib/safe-log";

/** رسائل مشكلات الأسطر — تُعرض للعميل مباشرةً فتلزم ترجمتها. */
const ISSUES = {
  ar: {
    variantGone: "لم يعد هذا الخيار متاحًا",
    shippingGone:
      "لم تعد طريقة الشحن المختارة متاحة — يُرجى إعادة اختيارها",
    outOfStock: "نفدت الكمية",
    onlyN: (n: number) => `المتوفّر ${n} فقط`,
    unavailable: "منتج غير متاح",
    refreshFailed: "تعذّر تحديث بيانات هذا المنتج",
  },
  en: {
    variantGone: "This option is no longer available",
    shippingGone:
      "The selected shipping method is no longer available — please choose again",
    outOfStock: "Out of stock",
    onlyN: (n: number) => `Only ${n} left`,
    unavailable: "Product unavailable",
    refreshFailed: "Could not refresh this product",
  },
} as const;

/**
 * تجميع السلة بأسعار وشحن **محدَّثين من المصدر**.
 *
 * هذا هو الموضع الذي يُعاد فيه التحقق من السعر والمخزون — لا وقت العرض.
 * أسعار AliExpress ومخزونها متغيّران، والاعتماد على لقطة قديمة يعني
 * البيع بسعر لم يعد قائمًا أو بيع قطعة نفدت.
 */

export interface CartLine {
  aeProductId: string;
  skuAttr: string;
  quantity: number;
  logisticsServiceName: string;

  title: string;
  imageUrl: string;
  variantLabel: string;

  unitPriceSar: number;
  linePriceSar: number;
  unitCostSource: number;
  shippingCostSource: number;
  shippingSar: number;
  shippingIncludesVat: boolean;
  shippingCompany: string;
  shippingEstimate: string;
  hasTracking: boolean;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;

  /** المخزون المتاح الآن — قد يقل عن الكمية المطلوبة */
  availableStock: number;
  /** مشكلة تمنع إتمام الشراء لهذا السطر */
  issue: string | null;
  /** رمز داخلي ثابت يسمح لمسار التوريد بالتمييز دون تحليل النص المترجم. */
  issueCode:
    | "VARIANT_UNAVAILABLE"
    | "SHIPPING_UNAVAILABLE"
    | "OUT_OF_STOCK"
    | "INSUFFICIENT_STOCK"
    | "UPSTREAM_FAILURE"
    | null;
  /** العطل المؤقت يعاد عبر الطابور، أما تغيّر المخزون/الخدمة فيحتاج قرارًا. */
  issueRetryable: boolean;
}

export interface CartSummary {
  lines: CartLine[];
  subtotalSar: number;
  shippingSar: number;
  vatSar: number;
  totalSar: number;
  fxRate: number;
  costSubtotal: number;
  costShipping: number;
  /** أطول مدة تسليم متوقعة عبر جميع الأسطر */
  maxDeliveryDays: number | null;
  hasIssues: boolean;
  hasUntracked: boolean;
}

/**
 * وجهة اختيارية لتسعير الشحن. صفحة المنتج والسلة تستطيعان عرض تقدير على
 * مستوى الدولة، أما التثبيت والدفع فيمرران المحافظة الفعلية من عنوان موثوق.
 */
export interface ShippingDestination {
  province?: string;
  provinceCode?: string;
  cityCode?: string;
}

export async function buildCartSummary(
  cart: Cart,
  localeArg?: Locale,
  destination?: ShippingDestination,
): Promise<CartSummary> {
  // لا تُقرأ الكوكيز هنا: الدالة تُستدعى أيضًا من سياقات بلا طلب
  const locale = localeArg ?? DEFAULT_LOCALE;
  const msg = ISSUES[locale];
  const lines: CartLine[] = [];

  // سعر الصرف يُحسم مرة واحدة لكل سلة: لو تُرك لكل استدعاء أن يقرأه بنفسه
  // لأمكن أن يتغيّر السعر بين سطر وآخر داخل التجميع نفسه فلا يطابق
  // مجموع الأسطر الإجمالي المعروض.
  // وهنا كان الخلل: هذه الاستدعاءات كانت تسقط إلى قيمة متغيّر البيئة،
  // فسعر يضبطه المسؤول في لوحة الإعدادات يُتجاهَل تمامًا عند الدفع.
  const [fxRate, margins] = await Promise.all([
    effectiveFxRateAsync(),
    productMargins(cart),
  ]);

  for (const item of cart) {
    let line: CartLine | null = null;
    const marginPercent = margins.get(item.aeProductId);

    try {
      const [product, shipping] = await Promise.all([
        getProduct(item.aeProductId),
        getShippingOptions({
          aeProductId: item.aeProductId,
          quantity: item.quantity,
          ...(destination?.province
            ? { province: destination.province }
            : {}),
          ...(destination?.provinceCode
            ? { provinceCode: destination.provinceCode }
            : {}),
          ...(destination?.cityCode ? { cityCode: destination.cityCode } : {}),
        }),
      ]);

      const sku = product.skus.find((s) => s.skuAttr === item.skuAttr);
      const ship = shipping.find((s) => s.code === item.logisticsServiceName);

      if (!sku) {
        line = brokenLine(item, product.title, msg.variantGone, {
          issueCode: "VARIANT_UNAVAILABLE",
        });
      } else if (!ship) {
        // خط الشحن اختفى — يجب على العميل إعادة الاختيار
        line = brokenLine(
          item,
          product.title,
          msg.shippingGone,
          {
            imageUrl: product.imageUrls[0],
            variantLabel: sku.variantLabel,
            issueCode: "SHIPPING_UNAVAILABLE",
          },
        );
      } else {
        const unitPriceSar = retailUnitPriceSar(sku.sourcePrice, {
          marginPercent,
          fxRate,
        });
        const shippingSar = toSar(ship.feeSource, fxRate);
        const availableStock =
          ship.availableStock == null
            ? sku.stock
            : Math.min(sku.stock, ship.availableStock);
        const issue =
          availableStock === 0
            ? msg.outOfStock
            : availableStock < item.quantity
              ? msg.onlyN(availableStock)
              : null;
        const issueCode =
          availableStock === 0
            ? "OUT_OF_STOCK"
            : availableStock < item.quantity
              ? "INSUFFICIENT_STOCK"
              : null;

        line = {
          aeProductId: item.aeProductId,
          skuAttr: item.skuAttr,
          quantity: item.quantity,
          logisticsServiceName: item.logisticsServiceName,
          title: product.title,
          imageUrl: sku.imageUrl ?? product.imageUrls[0] ?? "",
          variantLabel: sku.variantLabel,
          unitPriceSar,
          linePriceSar: unitPriceSar * item.quantity,
          unitCostSource: sku.sourcePrice,
          shippingCostSource: ship.feeSource,
          shippingSar,
          shippingIncludesVat: ship.includesVat,
          shippingCompany: ship.company,
          shippingEstimate: deliveryEstimateAr(ship.minDays, ship.maxDays, locale),
          hasTracking: ship.hasTracking,
          minDeliveryDays: ship.minDays,
          maxDeliveryDays: ship.maxDays,
          availableStock,
          issue,
          issueCode,
          issueRetryable: false,
        };
      }
    } catch (e) {
      const reason =
        e instanceof AeApiError
          ? e.customerMessage
          : msg.refreshFailed;
      line = brokenLine(item, msg.unavailable, reason, {
        issueCode: "UPSTREAM_FAILURE",
        issueRetryable:
          e instanceof AeApiError &&
          (e.isRetryable || e.needsRefresh || e.errorClass === "AUTH"),
      });
    }

    lines.push(line);
  }

  const usable = lines.filter((l) => !l.issue);
  const totals = calculateTotals(
    usable.map((l) => ({
      unitCostSource: l.unitCostSource,
      quantity: l.quantity,
      shippingCostSource: l.shippingCostSource,
      shippingIncludesVat: l.shippingIncludesVat,
      marginPercent: margins.get(l.aeProductId),
    })),
    fxRate,
  );

  const maxDays = usable.reduce<number | null>(
    (max, l) =>
      l.maxDeliveryDays == null ? max : Math.max(max ?? 0, l.maxDeliveryDays),
    null,
  );

  return {
    lines,
    subtotalSar: totals.subtotalSar,
    shippingSar: totals.shippingSar,
    vatSar: totals.vatSar,
    totalSar: totals.totalSar,
    fxRate: totals.fxRate,
    costSubtotal: totals.costSource,
    costShipping: totals.shippingSource,
    maxDeliveryDays: maxDays,
    hasIssues: lines.some((l) => l.issue !== null),
    hasUntracked: usable.some((l) => !l.hasTracking),
  };
}

/**
 * هوامش الربح الخاصة بمنتجات السلة، باستعلام واحد لا استعلام لكل سطر.
 *
 * المفقود من المرآة المحلية لا يُدرَج في الخريطة إطلاقًا، فيقع التسعير
 * على الهامش الافتراضي — وهو السلوك الصحيح: غياب الصف ليس هامشًا صفريًا.
 * وتعثّر القراءة يُبتلع للسبب نفسه: الهامش الخاص تحسين تجاري، وإسقاط
 * السلة كلها لأجله خسارة أكبر من بيع سطر بالهامش الافتراضي.
 */
async function productMargins(cart: Cart): Promise<Map<string, number>> {
  const ids = [...new Set(cart.map((i) => i.aeProductId))];
  if (ids.length === 0) return new Map();

  try {
    const rows = await prisma.product.findMany({
      where: { aeProductId: { in: ids }, marginPercent: { not: null } },
      select: { aeProductId: true, marginPercent: true },
    });

    return new Map(
      // Decimal من Prisma — التحويل إلزامي قبل أي استخدام حسابي
      rows.map((r) => [r.aeProductId, Number(r.marginPercent)]),
    );
  } catch (e) {
    console.error(
      "[cart] تعذّرت قراءة هوامش المنتجات — سيُستخدم الافتراضي:",
      safeErrorKind(e),
    );
    return new Map();
  }
}

function brokenLine(
  item: Cart[number],
  title: string,
  issue: string,
  options: {
    imageUrl?: string;
    variantLabel?: string;
    issueCode: Exclude<CartLine["issueCode"], null>;
    issueRetryable?: boolean;
  },
): CartLine {
  return {
    aeProductId: item.aeProductId,
    skuAttr: item.skuAttr,
    quantity: item.quantity,
    logisticsServiceName: item.logisticsServiceName,
    title,
    imageUrl: options.imageUrl ?? "",
    variantLabel: options.variantLabel ?? "",
    unitPriceSar: 0,
    linePriceSar: 0,
    unitCostSource: 0,
    shippingCostSource: 0,
    shippingSar: 0,
    shippingIncludesVat: false,
    shippingCompany: "",
    shippingEstimate: "",
    hasTracking: false,
    minDeliveryDays: null,
    maxDeliveryDays: null,
    availableStock: 0,
    issue,
    issueCode: options.issueCode,
    issueRetryable: options.issueRetryable ?? false,
  };
}

export { formatSar };
