import { cache } from "react";
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
 *
 * مغلّفة بـ cache() لسبب جوهري: صفحة المنتج تستدعيها من generateMetadata
 * ومن جسم الصفحة معًا. بدون التغليف يجري الاستدعاء مرتين بالتوازي،
 * فتتسابق عمليتا الكتابة على الصفوف نفسها ويفشل الطلب.
 */
export const fetchAndMirrorProduct = cache(
  async (aeProductId: string): Promise<ProductDetail> => {
    const detail = await getProduct(aeProductId);
    const cfg = env();

    // كتابة واحدة متسلسلة داخل معاملة: تضمن الاتساق وتتجنّب
    // استعلام N+1 الذي كان يجلب معرّف المنتج مرة لكل وحدة SKU.
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.upsert({
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
        select: { id: true },
      });

      for (const s of detail.skus) {
        await tx.productSku.upsert({
          where: {
            productId_skuAttr: { productId: product.id, skuAttr: s.skuAttr },
          },
          create: {
            productId: product.id,
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
            aeSkuId: s.aeSkuId,
            sourcePrice: s.sourcePrice,
            bulkPrice: s.bulkPrice,
            stock: s.stock,
            variantLabel: s.variantLabel,
            imageUrl: s.imageUrl,
          },
        });
      }
    });

    return detail;
  },
);
