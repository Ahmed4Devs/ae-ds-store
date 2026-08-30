import { notFound } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { AddToCartForm } from "@/components/add-to-cart-form";
import { Alert, Card } from "@/components/ui";
import { fetchAndMirrorProduct } from "@/lib/catalog";
import { getShippingOptions, AeApiError } from "@/lib/aliexpress";
import { retailUnitPriceSar, formatSar, toSar } from "@/lib/pricing";
import { deliveryEstimateAr } from "@/lib/ksa";

export async function generateMetadata(props: PageProps<"/product/[id]">) {
  const { id } = await props.params;
  try {
    const p = await fetchAndMirrorProduct(id);
    return { title: p.title.slice(0, 70) };
  } catch {
    return { title: "المنتج غير متاح" };
  }
}

export default async function ProductPage(props: PageProps<"/product/[id]">) {
  const { id } = await props.params;

  let product;
  try {
    product = await fetchAndMirrorProduct(id);
  } catch (e) {
    if (e instanceof AeApiError) notFound();
    throw e;
  }

  if (product.skus.length === 0) notFound();

  // خيارات الشحن إلى السعودية — تُجلب لكمية واحدة كأساس للعرض
  let shipping: Awaited<ReturnType<typeof getShippingOptions>> = [];
  let shippingError: string | null = null;
  try {
    shipping = await getShippingOptions({ aeProductId: id, quantity: 1 });
  } catch (e) {
    shippingError =
      e instanceof AeApiError
        ? e.customerMessage
        : "تعذّر حساب الشحن حاليًا.";
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
          {/* الصور */}
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

          {/* التفاصيل */}
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
                  {product.ordersCount.toLocaleString("en")} طلب سابق
                </span>
              )}
            </div>

            <p className="mt-5 text-3xl font-bold text-brand-700 dark:text-brand-400 nums">
              {formatSar(retailUnitPriceSar(cheapest))}
            </p>
            <p className="mt-1 text-xs text-ink-500">
              السعر شامل ضريبة القيمة المضافة · الشحن يُحتسب حسب الخيار المختار
            </p>

            {!inStock && (
              <div className="mt-5">
                <Alert tone="warning" title="غير متوفر حاليًا">
                  نفدت الكمية من جميع الخيارات. تحقّق لاحقًا.
                </Alert>
              </div>
            )}

            {shippingError && (
              <div className="mt-5">
                <Alert tone="warning" title="تعذّر حساب الشحن">
                  {shippingError}
                </Alert>
              </div>
            )}

            {inStock && shipping.length > 0 && (
              <div className="mt-6">
                <AddToCartForm
                  aeProductId={product.aeProductId}
                  skus={product.skus.map((s) => ({
                    skuAttr: s.skuAttr,
                    label: s.variantLabel,
                    stock: s.stock,
                    priceSar: retailUnitPriceSar(s.sourcePrice),
                  }))}
                  shipping={shipping.map((o) => ({
                    code: o.code,
                    company: o.company,
                    feeSar: toSar(o.feeSource),
                    isFree: o.isFree,
                    hasTracking: o.hasTracking,
                    estimate: deliveryEstimateAr(o.minDays, o.maxDays),
                  }))}
                />
              </div>
            )}

            {/* المواصفات */}
            {product.properties.length > 0 && (
              <Card className="mt-8 overflow-hidden">
                <p className="border-b border-[--color-border-app] px-4 py-3 font-semibold">
                  المواصفات
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
