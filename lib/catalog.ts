import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getProduct, searchProducts, type ProductDetail } from "@/lib/aliexpress";
import { retailUnitPriceSar } from "@/lib/pricing";

/**
 * خدمة الكتالوج — تربط بين نتائج AliExpress والمرآة المحلية.
 *
 * المبدأ الحاكم: نعرض من المرآة المحلية للسرعة، لكن **نعيد التحقق من
 * السعر والمخزون من المصدر لحظة الشراء** لا لحظة العرض، لأن أسعار
 * AliExpress ومخزونها متغيّران باستمرار.
 */

export interface CatalogCard {
  aeProductId: string;
  title: string;
  imageUrl: string;
  priceSar: number;
  comparePriceSar: number | null;
  ordersCount: number;
  rating: number | null;
}

/** يحوّل نتيجة بحث إلى بطاقة عرض بسعر الريال. */
export function toCard(item: {
  aeProductId: string;
  title: string;
  imageUrl: string;
  sourcePrice: number;
  sourceOriginalPrice: number | null;
  ordersCount: number;
  rating: number | null;
}): CatalogCard {
  return {
    aeProductId: item.aeProductId,
    title: item.title,
    imageUrl: item.imageUrl,
    priceSar: retailUnitPriceSar(item.sourcePrice),
    comparePriceSar: item.sourceOriginalPrice
      ? retailUnitPriceSar(item.sourceOriginalPrice)
      : null,
    ordersCount: item.ordersCount,
    rating: item.rating,
  };
}

/** بحث في الكتالوج عبر AliExpress مباشرة. */
export async function browse(params: {
  keyword?: string;
  categoryId?: string;
  page?: number;
  pageSize?: number;
  sortBy?: "min_price,asc" | "min_price,desc" | "orders,desc";
}): Promise<{ cards: CatalogCard[]; total: number; page: number }> {
  const res = await searchProducts({
    keyword: params.keyword,
    categoryId: params.categoryId,
    page: params.page ?? 1,
    pageSize: params.pageSize ?? 24,
    sortBy: params.sortBy,
  });

  return {
    cards: res.items.map(toCard),
    total: res.total,
    page: res.page,
  };
}

/**
 * يجلب تفاصيل منتج من AliExpress ويحفظ نسخة محلية.
 * الحفظ يتيح لصفحات الطلبيات عرض بيانات المنتج بعد أن يختفي من المصدر.
 */
export async function fetchAndMirrorProduct(
  aeProductId: string,
): Promise<ProductDetail> {
  const detail = await getProduct(aeProductId);
  const cfg = env();

  await prisma.product.upsert({
    where: { aeProductId: detail.aeProductId },
    create: {
      aeProductId: detail.aeProductId,
      title: detail.title,
      description: detail.descriptionHtml,
      mainImageUrl: detail.imageUrls[0] ?? "",
      imageUrls: detail.imageUrls,
      aeCategoryId: detail.categoryId,
      rating: detail.rating ?? undefined,
      ordersCount: detail.ordersCount,
      sourceCurrency: detail.currency || cfg.AE_SOURCE_CURRENCY,
      properties: detail.properties,
      lastSyncedAt: new Date(),
      skus: {
        create: detail.skus.map((s) => ({
          aeSkuId: s.aeSkuId,
          skuAttr: s.skuAttr,
          variantLabel: s.variantLabel,
          imageUrl: s.imageUrl,
          sourcePrice: s.sourcePrice,
          bulkPrice: s.bulkPrice,
          bulkMinQty: s.bulkMinQty,
          stock: s.stock,
        })),
      },
    },
    update: {
      title: detail.title,
      description: detail.descriptionHtml,
      mainImageUrl: detail.imageUrls[0] ?? "",
      imageUrls: detail.imageUrls,
      rating: detail.rating ?? undefined,
      ordersCount: detail.ordersCount,
      properties: detail.properties,
      lastSyncedAt: new Date(),
    },
  });

  // تحديث وحدات الـ SKU بالسعر والمخزون الحاليين
  for (const s of detail.skus) {
    await prisma.productSku.upsert({
      where: {
        productId_skuAttr: {
          productId: (await productIdFor(detail.aeProductId)) ?? "",
          skuAttr: s.skuAttr,
        },
      },
      create: {
        productId: (await productIdFor(detail.aeProductId)) ?? "",
        aeSkuId: s.aeSkuId,
        skuAttr: s.skuAttr,
        variantLabel: s.variantLabel,
        imageUrl: s.imageUrl,
        sourcePrice: s.sourcePrice,
        bulkPrice: s.bulkPrice,
        bulkMinQty: s.bulkMinQty,
        stock: s.stock,
      },
      update: {
        sourcePrice: s.sourcePrice,
        bulkPrice: s.bulkPrice,
        stock: s.stock,
        variantLabel: s.variantLabel,
        imageUrl: s.imageUrl,
      },
    });
  }

  return detail;
}

async function productIdFor(aeProductId: string): Promise<string | null> {
  const p = await prisma.product.findUnique({
    where: { aeProductId },
    select: { id: true },
  });
  return p?.id ?? null;
}
