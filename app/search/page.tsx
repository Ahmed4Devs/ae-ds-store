import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ProductGrid } from "@/components/product-card";
import { browse } from "@/lib/catalog";
import { EmptyState, ButtonLink } from "@/components/ui";

export const metadata = { title: "نتائج البحث" };

const SORTS = [
  { value: "", label: "الأكثر صلة" },
  { value: "orders,desc", label: "الأكثر مبيعًا" },
  { value: "min_price,asc", label: "السعر: من الأقل" },
  { value: "min_price,desc", label: "السعر: من الأعلى" },
] as const;

export default async function SearchPage(props: PageProps<"/search">) {
  const sp = await props.searchParams;
  const keyword = typeof sp.q === "string" ? sp.q : "";
  const category = typeof sp.category === "string" ? sp.category : undefined;
  const sort = typeof sp.sort === "string" ? sp.sort : "";
  const page = Number(typeof sp.page === "string" ? sp.page : "1") || 1;

  const result = await browse({
    keyword,
    categoryId: category,
    page,
    pageSize: 24,
    sortBy: (sort || undefined) as never,
  });

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
              {keyword ? `نتائج البحث عن «${keyword}»` : "جميع المنتجات"}
            </h1>
            <p className="mt-1 text-sm text-ink-500 nums">
              {result.total.toLocaleString("en")} منتج
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {SORTS.map((s) => (
              <Link
                key={s.value}
                href={buildHref({ sort: s.value, page: undefined })}
                className={
                  "rounded-full border px-3.5 py-1.5 text-sm transition " +
                  (sort === s.value
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-[--color-border-app] hover:border-brand-400")
                }
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>

        {result.cards.length === 0 ? (
          <EmptyState
            title="لا توجد نتائج"
            description="جرّب كلمات بحث أخرى أو تصفّح جميع المنتجات."
            action={<ButtonLink href="/search">عرض جميع المنتجات</ButtonLink>}
          />
        ) : (
          <>
            <ProductGrid products={result.cards} />

            {totalPages > 1 && (
              <nav className="mt-10 flex items-center justify-center gap-2">
                {page > 1 && (
                  <Link
                    href={buildHref({ page: page - 1 })}
                    className="rounded-lg border border-[--color-border-app] px-4 py-2 text-sm hover:border-brand-400"
                  >
                    السابق
                  </Link>
                )}
                <span className="px-3 text-sm text-ink-500 nums">
                  {page} من {totalPages}
                </span>
                {page < totalPages && (
                  <Link
                    href={buildHref({ page: page + 1 })}
                    className="rounded-lg border border-[--color-border-app] px-4 py-2 text-sm hover:border-brand-400"
                  >
                    التالي
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
