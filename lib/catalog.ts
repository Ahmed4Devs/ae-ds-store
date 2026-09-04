import { cache } from "react";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getProduct, searchProducts, type ProductDetail } from "@/lib/aliexpress";
import { retailUnitPriceSar } from "@/lib/pricing";
import { effectiveFxRateAsync } from "@/lib/fx";

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

/**
 * يحوّل نتيجة بحث إلى بطاقة عرض بسعر الريال.
 *
 * تمرير `fxRate` و`marginPercent` صراحةً مقصود: السعر المعروض على البطاقة
 * يجب أن يطابق ما تحسبه السلة لاحقًا، ولو تُرك لكل بطاقة أن تقرأ السعر
 * بنفسها لعادت إلى قيمة متغيّر البيئة بدل السعر المسجَّل في قاعدة البيانات.
 */
export function toCard(
  item: {
    aeProductId: string;
    title: string;
    imageUrl: string;
    sourcePrice: number;
    sourceOriginalPrice: number | null;
    ordersCount: number;
    rating: number | null;
  },
  opts: { fxRate?: number; marginPercent?: number } = {},
): CatalogCard {
  return {
    aeProductId: item.aeProductId,
    title: item.title,
    imageUrl: item.imageUrl,
    priceSar: retailUnitPriceSar(item.sourcePrice, opts),
    comparePriceSar: item.sourceOriginalPrice
      ? retailUnitPriceSar(item.sourceOriginalPrice, opts)
      : null,
    ordersCount: item.ordersCount,
    rating: item.rating,
  };
}

/**
 * بحث في الكتالوج عبر AliExpress مباشرة.
 *
 * ⚠️ الفرق الجوهري عن `publishedCards`: هذه الدالة تفتح **المنصة كاملة**
 * ولا تقتصر على المرآة المحلية. تقييدها بالمنشور كان سيقلّص البحث العام
 * إلى بضعة منتجات اختارتها الإدارة، وهو عكس الغرض منه.
 * أما `publishedCards` فهي مختاراتنا: المرآة المحلية والمنشور منها فقط.
 */
export async function browse(params: {
  keyword?: string;
  categoryId?: string;
  page?: number;
  pageSize?: number;
  sortBy?: "min_price,asc" | "min_price,desc" | "orders,desc";
}): Promise<{ cards: CatalogCard[]; total: number; page: number }> {
  const [res, fxRate] = await Promise.all([
    searchProducts({
      keyword: params.keyword,
      categoryId: params.categoryId,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 24,
      sortBy: params.sortBy,
    }),
    effectiveFxRateAsync(),
  ]);

  return {
    // لا تُمرَّر toCard إلى map مباشرةً: map يمرّر الفهرس كوسيط ثانٍ
    // فيحلّ رقمًا محلّ خيارات التسعير
    cards: res.items.map((item) => toCard(item, { fxRate })),
    total: res.total,
    page: res.page,
  };
}

/**
 * مختارات المتجر — المنتجات المنشورة من المرآة المحلية فقط.
 *
 * هذا ما يمنح الحقل `isPublished` معناه: المرآة تمتلئ تلقائيًا بكل منتج
 * فُتحت صفحته ولو مرة، فلو عُرضت كما هي لصارت الصفحة سجلّ تصفّح لا
 * اختيارًا تجاريًا. النشر قرار إداري صريح.
 */
export async function publishedCards(
  params: { page?: number; pageSize?: number } = {},
): Promise<{ cards: CatalogCard[]; total: number; page: number }> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? 24;

  const [rows, total, fxRate] = await Promise.all([
    prisma.product.findMany({
      where: { isPublished: true },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        aeProductId: true,
        title: true,
        mainImageUrl: true,
        ordersCount: true,
        rating: true,
        marginPercent: true,
        // أرخص وحدة SKU هي السعر المعروض على البطاقة («يبدأ من»)
        skus: {
          select: { sourcePrice: true },
          orderBy: { sourcePrice: "asc" },
          take: 1,
        },
      },
    }),
    prisma.product.count({ where: { isPublished: true } }),
    effectiveFxRateAsync(),
  ]);

  const cards = rows
    // منتج بلا وحدات SKU لا سعر له — عرضه بصفر أسوأ من إخفائه
    .filter((p) => p.skus.length > 0)
    .map((p) =>
      toCard(
        {
          aeProductId: p.aeProductId,
          title: p.title,
          imageUrl: p.mainImageUrl,
          // Decimal من Prisma — التحويل إلزامي قبل الحساب
          sourcePrice: Number(p.skus[0].sourcePrice),
          // المرآة لا تحفظ السعر قبل الخصم، فلا سعر مشطوب هنا
          sourceOriginalPrice: null,
          ordersCount: p.ordersCount,
          rating: p.rating == null ? null : Number(p.rating),
        },
        {
          fxRate,
          marginPercent:
            p.marginPercent == null ? undefined : Number(p.marginPercent),
        },
      ),
    );

  return { cards, total, page };
}

/**
 * يجلب تفاصيل منتج من AliExpress ويحفظ نسخة محلية.
 *
 * مغلّفة بـ cache() لسبب جوهري: صفحة المنتج تستدعيها من generateMetadata
 * ومن جسم الصفحة معًا. بدون التغليف يجري الاستدعاء مرتين بالتوازي،
 * فتتسابق عمليتا الكتابة على الصفوف نفسها ويفشل الطلب.
 *
 * ⚠️ لا تلمس هذه الدالة الحقلين `isPublished` و`marginPercent` لا إنشاءً
 * ولا تحديثًا. المرآة تُكتب من زيارة أي عابر لصفحة منتج، فلو كتبتهما
 * لأعادت كل مزامنة منتجًا أخفته الإدارة إلى الواجهة ومحت هامشه الخاص.
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
