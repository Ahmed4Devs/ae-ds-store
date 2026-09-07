import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ProductGrid } from "@/components/product-card";
import { browse } from "@/lib/catalog";
import { EmptyState, ButtonLink } from "@/components/ui";
import { fill, getDictionary, getLocale } from "@/lib/i18n";

const SORT_VALUES = [
  "",
  "orders,desc",
  "min_price,asc",
  "min_price,desc",
] as const;

const searchParamsSchema = z.object({
  q: z
    .string()
    .max(120)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
    .transform((value) => value.trim().replace(/\s+/g, " ")),
  category: z.string().regex(/^\d{1,32}$/).optional(),
  sort: z.enum(SORT_VALUES),
  page: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
});

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.search.titleAll };
}

export default async function SearchPage(props: PageProps<"/search">) {
  const sp = await props.searchParams;
  const allowedKeys = new Set(["q", "category", "sort", "page"]);
  if (
    Object.keys(sp).some((key) => !allowedKeys.has(key)) ||
    [sp.q, sp.category, sp.sort, sp.page].some(Array.isArray)
  ) {
    notFound();
  }

  const parsed = searchParamsSchema.safeParse({
    q: typeof sp.q === "string" ? sp.q : "",
    category:
      typeof sp.category === "string" && sp.category !== ""
        ? sp.category
        : undefined,
    sort: typeof sp.sort === "string" ? sp.sort : "",
    page: typeof sp.page === "string" ? sp.page : "1",
  });
  // المدخل المشوّه لا يصل AliExpress ولا يتحول إلى استعلام مكلف غير محدود.
  if (!parsed.success) notFound();

  const { q: keyword, category, sort, page } = parsed.data;

  const [result, t, locale] = await Promise.all([
    browse({
      keyword,
      categoryId: category,
      page,
      pageSize: 24,
      sortBy: sort || undefined,
    }),
    getDictionary(),
    getLocale(),
  ]);

  const sorts = [
    { value: "", label: t.search.sortRelevance },
    { value: "orders,desc", label: t.search.sortBestSelling },
    { value: "min_price,asc", label: t.search.sortPriceAsc },
    { value: "min_price,desc", label: t.search.sortPriceDesc },
  ];

  const totalPages = Math.max(1, Math.ceil(result.total / 24));

  const buildHref = (patch: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    if (keyword) params.set("q", keyword);
    if (category) params.set("category", category);
    if (sort) params.set("sort", sort);
    if (page > 1) params.set("page", String(page));
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k);
      else params.set(k, String(v));
    }
    const qs = params.toString();
    return `/search${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">
              {keyword ? fill(t.search.title, { q: keyword }) : t.search.titleAll}
            </h1>
            <p className="nums mt-1 text-sm text-ink-500">
              {fill(t.search.count, { n: result.total.toLocaleString("en") })}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {sorts.map((s) => (
              <Link
                key={s.value}
                href={buildHref({ sort: s.value, page: undefined })}
                className={
                  "rounded-full border px-3.5 py-1.5 text-sm transition " +
                  (sort === s.value
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-(--color-border-app) hover:border-brand-400")
                }
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>

        {result.cards.length === 0 ? (
          <EmptyState
            title={t.search.emptyTitle}
            description={t.search.emptyBody}
            action={<ButtonLink href="/search">{t.search.emptyCta}</ButtonLink>}
          />
        ) : (
          <>
            <ProductGrid products={result.cards} locale={locale} />

            {totalPages > 1 && (
              <nav className="mt-10 flex items-center justify-center gap-2">
                {page > 1 && (
                  <Link
                    href={buildHref({ page: page - 1 })}
                    className="rounded-lg border border-(--color-border-app) px-4 py-2 text-sm hover:border-brand-400"
                  >
                    {t.common.previous}
                  </Link>
                )}
                <span className="nums px-3 text-sm text-ink-500">
                  {fill(t.common.pageOf, { current: page, total: totalPages })}
                </span>
                {page < totalPages && (
                  <Link
                    href={buildHref({ page: page + 1 })}
                    className="rounded-lg border border-(--color-border-app) px-4 py-2 text-sm hover:border-brand-400"
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
