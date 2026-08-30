import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ProductGrid } from "@/components/product-card";
import { browse } from "@/lib/catalog";
import { getCategories } from "@/lib/aliexpress";
import { ButtonLink, Card } from "@/components/ui";

export default async function HomePage() {
  const [featured, categories] = await Promise.all([
    browse({ pageSize: 8, sortBy: "orders,desc" }),
    getCategories().catch(() => []),
  ]);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        {/* البطل */}
        <section className="mb-10 overflow-hidden rounded-2xl bg-gradient-to-l from-brand-700 to-brand-500 px-6 py-12 text-white sm:px-12 sm:py-16">
          <h1 className="max-w-2xl text-3xl font-bold leading-tight sm:text-4xl">
            منتجات عالمية تصل إلى بابك في المملكة
          </h1>
          <p className="mt-3 max-w-xl leading-relaxed text-brand-50">
            أسعار بالريال السعودي شاملة الضريبة، مع بيان صريح لمدة الشحن قبل
            إتمام الطلب — بلا مفاجآت.
          </p>
          <ButtonLink
            href="/search"
            variant="secondary"
            size="lg"
            className="mt-7 bg-white text-brand-700 hover:bg-brand-50"
          >
            ابدأ التسوّق
          </ButtonLink>
        </section>

        {/* مزايا */}
        <section className="mb-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              t: "أسعار شفافة",
              d: "السعر النهائي بالريال شامل ضريبة القيمة المضافة والشحن — يُحتسب قبل الدفع.",
            },
            {
              t: "مدة شحن معلنة",
              d: "نعرض المدة المتوقّعة لكل خيار شحن، ونوضّح إن كان قابلًا للتتبع أم لا.",
            },
            {
              t: "تتبّع خطوة بخطوة",
              d: "رقم تتبع ومسار الشحنة داخل حسابك فور شحن الطلب.",
            },
          ].map((f) => (
            <Card key={f.t} className="p-5">
              <p className="font-semibold">{f.t}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{f.d}</p>
            </Card>
          ))}
        </section>

        {/* الفئات */}
        {categories.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-4 text-xl font-bold">تصفّح حسب الفئة</h2>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <Link
                  key={c.categoryId}
                  href={`/search?category=${c.categoryId}`}
                  className="rounded-full border border-[--color-border-app] bg-[--color-surface] px-4 py-2 text-sm transition hover:border-brand-500 hover:text-brand-700"
                >
                  {c.categoryName}
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* الأكثر طلبًا */}
        <section>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-xl font-bold">الأكثر طلبًا</h2>
            <Link href="/search" className="text-sm text-brand-600 hover:underline">
              عرض الكل
            </Link>
          </div>
          <ProductGrid products={featured.cards} />
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
