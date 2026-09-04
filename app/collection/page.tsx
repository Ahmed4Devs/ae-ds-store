import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ProductGrid } from "@/components/product-card";
import { ButtonLink, EmptyState } from "@/components/ui";
import { publishedCards } from "@/lib/catalog";
import { fill, getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.admin.productsTitle };
}

const PAGE_SIZE = 24;

/**
 * مختارات المتجر — المنشور من المرآة المحلية وحده.
 *
 * الفرق عن `/search` مقصود: البحث يمرّ إلى AliExpress كاملةً، وهذه الصفحة
 * تعرض ما اختارته الإدارة ونشرته صراحةً. بلا هذه الصفحة كان الحقل
 * `isPublished` موجودًا في المخطّط ولا يقرأه أحد.
 */
export default async function CollectionPage(
  props: PageProps<"/collection">,
) {
  const sp = await props.searchParams;
  const page = Math.max(1, Number(typeof sp.page === "string" ? sp.page : "1") || 1);

  const [result, t, locale] = await Promise.all([
    publishedCards({ page, pageSize: PAGE_SIZE }),
    getDictionary(),
    getLocale(),
  ]);

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const href = (p: number) => (p > 1 ? `/collection?page=${p}` : "/collection");

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{t.home.bestSelling}</h1>
          <p className="nums mt-1 text-sm text-ink-500">
            {fill(t.search.count, { n: result.total.toLocaleString("en") })}
          </p>
        </div>

        {result.cards.length === 0 ? (
          <EmptyState
            title={t.admin.noProducts}
            description={t.admin.noProductsBody}
            action={
              <ButtonLink href="/search">{t.search.emptyCta}</ButtonLink>
            }
          />
        ) : (
          <>
            <ProductGrid products={result.cards} locale={locale} />

            {totalPages > 1 && (
              <nav className="mt-10 flex items-center justify-center gap-2">
                {page > 1 && (
                  <Link
                    href={href(page - 1)}
                    className="rounded-lg border border-[--color-border-app] px-4 py-2 text-sm hover:border-brand-400"
                  >
                    {t.common.previous}
                  </Link>
                )}
                <span className="nums px-3 text-sm text-ink-500">
                  {fill(t.common.pageOf, { current: page, total: totalPages })}
                </span>
                {page < totalPages && (
                  <Link
                    href={href(page + 1)}
                    className="rounded-lg border border-[--color-border-app] px-4 py-2 text-sm hover:border-brand-400"
                  >
                    {t.common.next}
                  </Link>
                )}
              </nav>
            )}
          </>
        )}
      </main>

      <SiteFooter />
    </>
  );
}
