import { Card, EmptyState } from "@/components/ui";
import { requireAdmin } from "@/lib/session";
import {
  AdminImportForm,
  AdminProductRow,
  type AdminProductRowData,
} from "@/components/admin-product-row";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { effectiveFxRateAsync } from "@/lib/fx";
import { retailUnitPriceSar } from "@/lib/pricing";
import { getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.admin.products };
}

export default async function AdminProductsPage(
  props: PageProps<"/admin/products">,
) {
  // حارس ذاتي — لا يُكتفى بحماية التخطيط (راجع requireAdmin). يسبق كل قراءة.
  await requireAdmin();
  const sp = await props.searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();

  const cfg = env();
  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

  // البحث يشمل المعرّف لا العنوان وحده: المسؤول يصل غالبًا من رابط
  // منتج على AliExpress فلا يملك إلا الرقم
  const where = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" as const } },
          { aeProductId: { contains: q } },
        ],
      }
    : undefined;

  const [products, fxRate] = await Promise.all([
    prisma.product.findMany({
      where,
      // المنشور أولًا: هو ما تراجعه الإدارة فعليًا
      orderBy: [{ isPublished: "desc" }, { updatedAt: "desc" }],
      take: 100,
      select: {
        id: true,
        aeProductId: true,
        title: true,
        mainImageUrl: true,
        categoryName: true,
        aeCategoryId: true,
        isPublished: true,
        marginPercent: true,
        lastSyncedAt: true,
        skus: {
          select: { sourcePrice: true },
          orderBy: { sourcePrice: "asc" },
          take: 1,
        },
      },
    }),
    effectiveFxRateAsync(),
  ]);

  const rows: AdminProductRowData[] = products.map((p) => {
    // Decimal من Prisma — التحويل إلزامي قبل أي عملية حسابية
    const sourcePrice =
      p.skus.length > 0 ? Number(p.skus[0].sourcePrice) : null;
    const marginPercent =
      p.marginPercent == null ? null : Number(p.marginPercent);

    return {
      id: p.id,
      aeProductId: p.aeProductId,
      title: p.title,
      imageUrl: p.mainImageUrl,
      categoryName: p.categoryName ?? p.aeCategoryId,
      sourcePrice,
      retailSar:
        sourcePrice == null
          ? null
          : retailUnitPriceSar(sourcePrice, {
              fxRate,
              marginPercent: marginPercent ?? undefined,
            }),
      isPublished: p.isPublished,
      marginPercent,
      lastSyncedAt: p.lastSyncedAt?.toISOString() ?? null,
    };
  });

  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">{t.admin.productsTitle}</h1>
      <p className="mb-6 max-w-3xl text-sm leading-relaxed text-ink-500">
        {t.admin.productsBody}
      </p>

      <Card className="mb-6 p-5">
        <AdminImportForm labels={t.admin} />
      </Card>

      <form action="/admin/products" className="mb-5">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t.admin.productSearch}
          aria-label={t.admin.productSearch}
          className="h-11 w-full max-w-md rounded-lg border border-[--color-border-app] bg-[--color-background] px-3 text-sm outline-none focus:border-brand-500"
        />
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={t.admin.noProducts}
          description={t.admin.noProductsBody}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-[--color-background] text-xs text-ink-500">
                <tr>
                  <th className="px-5 py-2.5 text-right font-medium">
                    {t.admin.colProduct}
                  </th>
                  <th className="px-5 py-2.5 text-right font-medium">
                    {t.admin.colCategory}
                  </th>
                  <th className="px-5 py-2.5 text-right font-medium">
                    {t.admin.colPrice}
                  </th>
                  <th className="px-5 py-2.5 text-right font-medium">
                    {t.admin.colPublished}
                  </th>
                  <th className="px-5 py-2.5 text-right font-medium">
                    {t.admin.colMarginPct}
                  </th>
                  <th className="px-5 py-2.5 text-right font-medium">
                    {t.admin.colSynced}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--color-border-app]">
                {rows.map((p) => (
                  <AdminProductRow
                    key={p.id}
                    product={p}
                    locale={locale}
                    labels={t.admin}
                    commonLabels={t.common}
                    defaultMarginPercent={cfg.DEFAULT_MARGIN_PERCENT}
                    sourceCurrency={cfg.AE_SOURCE_CURRENCY}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
