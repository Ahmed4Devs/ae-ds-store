import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ProductGrid } from "@/components/product-card";
import { browse } from "@/lib/catalog";
import { getCategories } from "@/lib/aliexpress";
import { Card } from "@/components/ui";
import { getDictionary, getLocale } from "@/lib/i18n";
import { HeroCarousel, type HeroSlide } from "@/components/hero-carousel";
import { env } from "@/lib/env";

export default async function HomePage() {
  const locale = await getLocale();
  const [featured, categories, t] = await Promise.all([
    browse({ pageSize: 8, sortBy: "orders,desc" }),
    getCategories(locale).catch(() => []),
    getDictionary(),
  ]);

  const features = [
    { t: t.home.feature1Title, d: t.home.feature1Body },
    { t: t.home.feature2Title, d: t.home.feature2Body },
    { t: t.home.feature3Title, d: t.home.feature3Body },
  ];
  const heroProducts = featured.cards.slice(0, 3);
  const heroVideoPath = env().HERO_VIDEO_PATH;
  const heroSlides: HeroSlide[] = [
    {
      id: "intro",
      title: t.home.heroTitle,
      subtitle: t.home.heroSubtitle,
      ctaLabel: t.home.heroCta,
      href: "/search",
      media: heroVideoPath
        ? {
            type: "video",
            src: heroVideoPath,
            poster: heroProducts[0]?.imageUrl,
          }
        : heroProducts[0]
          ? { type: "image", src: heroProducts[0].imageUrl }
          : undefined,
    },
    ...heroProducts.slice(heroVideoPath ? 0 : 1).map((product) => ({
      id: `product-${product.aeProductId}`,
      title: product.title,
      subtitle: t.home.featuredHeroSubtitle,
      ctaLabel: t.home.featuredHeroCta,
      href: `/product/${product.aeProductId}`,
      media: { type: "image" as const, src: product.imageUrl },
    })),
  ];

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <HeroCarousel
          slides={heroSlides}
          previousLabel={t.common.previous}
          nextLabel={t.common.next}
          carouselLabel={t.home.heroCarouselLabel}
          goToSlideLabel={t.home.goToSlide}
        />

        <section className="mb-12 grid gap-4 sm:grid-cols-3">
          {features.map((f) => (
            <Card key={f.t} className="p-5">
              <p className="font-semibold">{f.t}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{f.d}</p>
            </Card>
          ))}
        </section>

        {categories.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-4 text-xl font-bold">{t.home.browseByCategory}</h2>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <Link
                  key={c.categoryId}
                  href={`/search?category=${c.categoryId}`}
                  className="inline-flex min-h-11 items-center rounded-full border border-(--color-border-app) bg-(--color-surface) px-4 py-2 text-sm transition hover:border-brand-500 hover:text-brand-700"
                >
                  {c.categoryName}
                </Link>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-xl font-bold">{t.home.bestSelling}</h2>
            <Link href="/search" className="inline-flex min-h-11 items-center text-sm text-brand-600 hover:underline">
              {t.home.viewAll}
            </Link>
          </div>
          <ProductGrid products={featured.cards} locale={locale} />
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
