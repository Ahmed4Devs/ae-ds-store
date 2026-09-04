import { SiteHeader, SiteFooter } from "@/components/site-header";
import { CartLines } from "@/components/cart-lines";
import { Alert, ButtonLink, Card, EmptyState } from "@/components/ui";
import { readCart } from "@/lib/cart";
import { buildCartSummary } from "@/lib/cart-service";
import { formatSar } from "@/lib/pricing";
import { fill, getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.cart.title };
}

export default async function CartPage() {
  const [cart, t, locale] = await Promise.all([
    readCart(),
    getDictionary(),
    getLocale(),
  ]);

  if (cart.length === 0) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16">
          <EmptyState
            title={t.cart.emptyTitle}
            description={t.cart.emptyBody}
            action={<ButtonLink href="/search">{t.cart.emptyCta}</ButtonLink>}
          />
        </main>
        <SiteFooter />
      </>
    );
  }

  const summary = await buildCartSummary(cart, locale);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">{t.cart.title}</h1>

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            {summary.hasIssues && (
              <Alert tone="warning" title={t.cart.issuesTitle}>
                {t.cart.issuesBody}
              </Alert>
            )}

            {summary.hasUntracked && (
              <Alert tone="info" title={t.cart.untrackedTitle}>
                {t.cart.untrackedBody}
              </Alert>
            )}

            <CartLines
              lines={summary.lines}
              locale={locale}
              labels={{
                remove: t.common.remove,
                increase: t.product.increase,
                decrease: t.product.decrease,
                notTrackable: t.product.notTrackable,
                shippingSuffix: t.cart.shippingSuffix,
              }}
            />
          </div>

          <div>
            <Card className="sticky top-20 p-5">
              <p className="mb-4 font-semibold">{t.cart.summary}</p>

              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-500">{t.cart.subtotal}</dt>
                  <dd className="nums">{formatSar(summary.subtotalSar, locale)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">{t.cart.shipping}</dt>
                  <dd className="nums">{formatSar(summary.shippingSar, locale)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">{t.cart.vat}</dt>
                  <dd className="nums">{formatSar(summary.vatSar, locale)}</dd>
                </div>
                <div className="flex justify-between border-t border-(--color-border-app) pt-3 text-base font-bold">
                  <dt>{t.cart.total}</dt>
                  <dd className="nums">{formatSar(summary.totalSar, locale)}</dd>
                </div>
              </dl>

              {summary.maxDeliveryDays != null && (
                <p className="mt-4 rounded-lg bg-(--color-background) p-3 text-xs leading-relaxed text-ink-500">
                  {fill(t.cart.deliveryNote, { n: summary.maxDeliveryDays })}
                </p>
              )}

              <ButtonLink
                href="/checkout"
                size="lg"
                className="mt-5 w-full"
                aria-disabled={summary.hasIssues}
              >
                {t.cart.checkout}
              </ButtonLink>

              {summary.hasIssues && (
                <p className="mt-2 text-center text-xs text-amber-700 dark:text-amber-400">
                  {t.cart.fixIssues}
                </p>
              )}
            </Card>
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
