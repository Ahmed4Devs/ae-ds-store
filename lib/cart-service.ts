import { getProduct, getShippingOptions, AeApiError } from "@/lib/aliexpress";
import { calculateTotals, formatSar, retailUnitPriceSar, toSar } from "@/lib/pricing";
import { deliveryEstimateAr } from "@/lib/ksa";
import type { Cart } from "@/lib/cart";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/shared";

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

export async function buildCartSummary(
  cart: Cart,
  localeArg?: Locale,
): Promise<CartSummary> {
  // لا تُقرأ الكوكيز هنا: الدالة تُستدعى أيضًا من سياقات بلا طلب
  const locale = localeArg ?? DEFAULT_LOCALE;
  const msg = ISSUES[locale];
  const lines: CartLine[] = [];

  for (const item of cart) {
    let line: CartLine | null = null;

    try {
      const [product, shipping] = await Promise.all([
        getProduct(item.aeProductId),
        getShippingOptions({
          aeProductId: item.aeProductId,
          quantity: item.quantity,
        }),
      ]);

      const sku = product.skus.find((s) => s.skuAttr === item.skuAttr);
      const ship = shipping.find((s) => s.code === item.logisticsServiceName);

      if (!sku) {
        line = brokenLine(item, product.title, msg.variantGone);
      } else if (!ship) {
        // خط الشحن اختفى — يجب على العميل إعادة الاختيار
        line = brokenLine(
          item,
          product.title,
          msg.shippingGone,
          product.imageUrls[0],
          sku.variantLabel,
        );
      } else {
        const unitPriceSar = retailUnitPriceSar(sku.sourcePrice);
        const shippingSar = toSar(ship.feeSource);
        const issue =
          sku.stock === 0
            ? msg.outOfStock
            : sku.stock < item.quantity
              ? msg.onlyN(sku.stock)
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
          availableStock: sku.stock,
          issue,
        };
      }
    } catch (e) {
      const reason =
        e instanceof AeApiError
          ? e.customerMessage
          : msg.refreshFailed;
      line = brokenLine(item, msg.unavailable, reason);
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
    })),
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

function brokenLine(
  item: Cart[number],
  title: string,
  issue: string,
  imageUrl = "",
  variantLabel = "",
): CartLine {
  return {
    aeProductId: item.aeProductId,
    skuAttr: item.skuAttr,
    quantity: item.quantity,
    logisticsServiceName: item.logisticsServiceName,
    title,
    imageUrl,
    variantLabel,
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
  };
}

export { formatSar };
