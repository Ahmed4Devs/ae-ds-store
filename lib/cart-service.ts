import { getProduct, getShippingOptions, AeApiError } from "@/lib/aliexpress";
import { calculateTotals, formatSar, retailUnitPriceSar, toSar } from "@/lib/pricing";
import { deliveryEstimateAr } from "@/lib/ksa";
import type { Cart } from "@/lib/cart";

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

export async function buildCartSummary(cart: Cart): Promise<CartSummary> {
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
        line = brokenLine(item, product.title, "لم يعد هذا الخيار متاحًا");
      } else if (!ship) {
        // خط الشحن اختفى — يجب على العميل إعادة الاختيار
        line = brokenLine(
          item,
          product.title,
          "لم تعد طريقة الشحن المختارة متاحة — يُرجى إعادة اختيارها",
          product.imageUrls[0],
          sku.variantLabel,
        );
      } else {
        const unitPriceSar = retailUnitPriceSar(sku.sourcePrice);
        const shippingSar = toSar(ship.feeSource);
        const issue =
          sku.stock === 0
            ? "نفدت الكمية"
            : sku.stock < item.quantity
              ? `المتوفّر ${sku.stock} فقط`
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
          shippingEstimate: deliveryEstimateAr(ship.minDays, ship.maxDays),
          hasTracking: ship.hasTracking,
          minDeliveryDays: ship.minDays,
          maxDeliveryDays: ship.maxDays,
          availableStock: sku.stock,
          issue,
        };
      }
    } catch (e) {
      const msg =
        e instanceof AeApiError
          ? e.customerMessage
          : "تعذّر تحديث بيانات هذا المنتج";
      line = brokenLine(item, "منتج غير متاح", msg);
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
