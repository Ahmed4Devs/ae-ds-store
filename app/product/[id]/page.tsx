import { notFound } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { AddToCartForm } from "@/components/add-to-cart-form";
import { Alert, Card } from "@/components/ui";
import { fetchAndMirrorProduct } from "@/lib/catalog";
import { prisma } from "@/lib/db";
import { effectiveFxRateAsync } from "@/lib/fx";
import { getShippingOptions, AeApiError } from "@/lib/aliexpress";
import { retailUnitPriceSar, formatSar, toSar } from "@/lib/pricing";
import { deliveryEstimateAr } from "@/lib/ksa";
import { fill, getDictionary, getLocale } from "@/lib/i18n";
import { getQueryClient } from "@/lib/query/client";
import { queryKeys, type ShippingOptionDto } from "@/lib/query/keys";

export async function generateMetadata(props: PageProps<"/product/[id]">) {
  const { id } = await props.params;
  try {
    const p = await fetchAndMirrorProduct(id);
    return { title: p.title.slice(0, 70) };
  } catch {
    return { title: "—" };
  }
}

export default async function ProductPage(props: PageProps<"/product/[id]">) {
  const { id } = await props.params;
  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

  let product;
  try {
    product = await fetchAndMirrorProduct(id);
  } catch (e) {
    if (e instanceof AeApiError) notFound();
    throw e;
  }

  if (product.skus.length === 0) notFound();

  /**
   * التسعير يطابق ما تحتسبه السلة تمامًا: سعر الصرف من قاعدة البيانات
   * (لا قيمة البيئة) وهامش المنتج الخاص إن وُجد. بدونهما كانت هذه الصفحة
   * تعرض سعرًا وتُحصّل السلة سعرًا آخر — العميل يرى رقمًا ويُخصم منه غيره.
   */
  const [fxRate, mirror] = await Promise.all([
    effectiveFxRateAsync(),
    prisma.product.findUnique({
      where: { aeProductId: id },
      select: { marginPercent: true },
    }),
  ]);
  const priceOpts = {
    fxRate,
    marginPercent:
      mirror?.marginPercent == null ? undefined : Number(mirror.marginPercent),
  };

  /**
   * جلب مسبق لخيارات الشحن بكمية واحدة.
   * يملأ ذاكرة TanStack قبل إرسال HTML، فتظهر الخيارات فورًا بلا وميض
   * تحميل، ثم يتولّى العميل إعادة الجلب عند تغيّر الكمية.
   */
  const queryClient = getQueryClient();
  let shippingError: string | null = null;

  try {
    const options = await getShippingOptions({ aeProductId: id, quantity: 1 });
    const dto: ShippingOptionDto[] = options.map((o) => ({
      code: o.code,
      company: o.company,
      feeSar: toSar(o.feeSource, fxRate),
      isFree: o.isFree,
      hasTracking: o.hasTracking,
      estimate: deliveryEstimateAr(o.minDays, o.maxDays, locale),
      minDays: o.minDays,
      maxDays: o.maxDays,
      availableStock: o.availableStock,
    }));
    queryClient.setQueryData(queryKeys.shipping(id, 1), dto);
  } catch (e) {
    shippingError = e instanceof AeApiError ? e.customerMessage : "—";
  }

  const cheapest = product.skus.reduce(
    (min, s) => Math.min(min, s.sourcePrice),
    Infinity,
  );
  const inStock = product.skus.some((s) => s.stock > 0);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <div className="overflow-hidden rounded-xl border border-[--color-border-app] bg-ink-100 dark:bg-ink-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={product.imageUrls[0]}
                alt={product.title}
                className="aspect-square w-full object-cover"
              />
            </div>
            {product.imageUrls.length > 1 && (
              <div className="mt-3 grid grid-cols-5 gap-2">
                {product.imageUrls.slice(0, 5).map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={url}
                    alt=""
                    className="aspect-square rounded-lg border border-[--color-border-app] object-cover"
                  />
                ))}
              </div>
            )}
          </div>

          <div>
            <h1 className="text-xl font-bold leading-relaxed sm:text-2xl">
              {product.title}
            </h1>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-ink-500">
              {product.rating != null && (
                <span className="flex items-center gap-1">
                  <svg viewBox="0 0 24 24" className="size-4 fill-amber-400">
                    <path d="M12 2l3 6.5 7 .9-5 4.8 1.2 7L12 17.8 5.8 21.2 7 14.2 2 9.4l7-.9z" />
                  </svg>
                  <span className="nums">{product.rating.toFixed(1)}</span>
                </span>
              )}
              {product.ordersCount > 0 && (
                <span className="nums">
                  {fill(t.product.ordersCount, {
                    n: product.ordersCount.toLocaleString("en"),
                  })}
                </span>
              )}
            </div>

            <p className="nums mt-5 text-3xl font-bold text-brand-700 dark:text-brand-400">
              {formatSar(retailUnitPriceSar(cheapest, priceOpts), locale)}
            </p>
            <p className="mt-1 text-xs text-ink-500">{t.product.priceNote}</p>

            {!inStock && (
              <div className="mt-5">
                <Alert tone="warning" title={t.product.outOfStockTitle}>
                  {t.product.outOfStockBody}
                </Alert>
              </div>
            )}

            {shippingError && (
              <div className="mt-5">
                <Alert tone="warning" title={t.product.shippingErrorTitle}>
                  {shippingError}
                </Alert>
              </div>
            )}

            {inStock && !shippingError && (
              <div className="mt-6">
                <HydrationBoundary state={dehydrate(queryClient)}>
                  <AddToCartForm
                    aeProductId={product.aeProductId}
                    locale={locale}
                    labels={{
                      variant: t.product.variant,
                      available: t.product.available,
                      shippingMethod: t.product.shippingMethod,
                      trackable: t.product.trackable,
                      notTrackable: t.product.notTrackable,
                      free: t.product.free,
                      quantity: t.product.quantity,
                      addToCart: t.product.addToCart,
                      adding: t.product.adding,
                      increase: t.product.increase,
                      decrease: t.product.decrease,
                      lineProduct: t.product.lineProduct,
                      lineShipping: t.product.lineShipping,
                      totalNote: t.product.totalNote,
                      updatingShipping: t.product.updatingShipping,
                      shippingErrorTitle: t.product.shippingErrorTitle,
                    }}
                    skus={product.skus.map((s) => ({
                      skuAttr: s.skuAttr,
                      label: s.variantLabel,
                      stock: s.stock,
                      priceSar: retailUnitPriceSar(s.sourcePrice, priceOpts),
                    }))}
                  />
                </HydrationBoundary>
              </div>
            )}

            {product.properties.length > 0 && (
              <Card className="mt-8 overflow-hidden">
                <p className="border-b border-[--color-border-app] px-4 py-3 font-semibold">
                  {t.product.specs}
                </p>
                <dl className="divide-y divide-[--color-border-app]">
                  {product.properties.map((p, i) => (
                    <div key={i} className="flex gap-4 px-4 py-2.5 text-sm">
                      <dt className="w-40 shrink-0 text-ink-500">{p.name}</dt>
                      <dd>{p.value}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
