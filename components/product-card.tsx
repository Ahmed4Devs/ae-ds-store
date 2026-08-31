import Link from "next/link";
import { formatSar } from "@/lib/pricing";
import type { CatalogCard } from "@/lib/catalog";
import type { Locale } from "@/lib/i18n/shared";

export function ProductCard({
  product,
  locale = "ar",
}: {
  product: CatalogCard;
  locale?: Locale;
}) {
  const hasDiscount =
    product.comparePriceSar != null && product.comparePriceSar > product.priceSar;
  const discountPercent = hasDiscount
    ? Math.round((1 - product.priceSar / product.comparePriceSar!) * 100)
    : 0;

  return (
    <Link
      href={`/product/${product.aeProductId}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-[--color-border-app] bg-[--color-surface] transition hover:border-brand-400 hover:shadow-lg"
    >
      <div className="relative aspect-square overflow-hidden bg-ink-100 dark:bg-ink-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={product.imageUrl}
          alt={product.title}
          loading="lazy"
          className="size-full object-cover transition duration-300 group-hover:scale-105"
        />
        {hasDiscount && (
          <span className="nums absolute top-2 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white ltr:left-2 rtl:right-2">
            −{discountPercent}%
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-2 text-sm leading-relaxed" title={product.title}>
          {product.title}
        </p>

        <div className="mt-auto pt-3">
          <div className="flex items-baseline gap-2">
            <span className="nums text-lg font-bold text-brand-700 dark:text-brand-400">
              {formatSar(product.priceSar, locale)}
            </span>
            {hasDiscount && (
              <span className="nums text-xs text-ink-400 line-through">
                {formatSar(product.comparePriceSar!, locale)}
              </span>
            )}
          </div>

          <div className="mt-1.5 flex items-center gap-3 text-xs text-ink-500">
            {product.rating != null && (
              <span className="flex items-center gap-1">
                <svg viewBox="0 0 24 24" className="size-3.5 fill-amber-400">
                  <path d="M12 2l3 6.5 7 .9-5 4.8 1.2 7L12 17.8 5.8 21.2 7 14.2 2 9.4l7-.9z" />
                </svg>
                <span className="nums">{product.rating.toFixed(1)}</span>
              </span>
            )}
            {product.ordersCount > 0 && (
              <span className="nums">{product.ordersCount.toLocaleString("en")}</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

export function ProductGrid({
  products,
  locale = "ar",
}: {
  products: CatalogCard[];
  locale?: Locale;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <ProductCard key={p.aeProductId} product={p} locale={locale} />
      ))}
    </div>
  );
}
