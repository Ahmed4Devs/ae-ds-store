import { redirect } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { CheckoutForm } from "@/components/checkout-form";
import { Alert, Card } from "@/components/ui";
import { readCart } from "@/lib/cart";
import { buildCartSummary } from "@/lib/cart-service";
import { formatSar } from "@/lib/pricing";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { fill, getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.checkout.title };
}

export default async function CheckoutPage() {
  const [cart, t, locale] = await Promise.all([
    readCart(),
    getDictionary(),
    getLocale(),
  ]);

  if (cart.length === 0) redirect("/cart");

  const summary = await buildCartSummary(cart, locale);
  if (summary.hasIssues) redirect("/cart");

  const user = await getCurrentUser();
  const savedAddress = user
    ? await prisma.address.findFirst({
        where: { userId: user.id },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      })
    : null;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">{t.checkout.title}</h1>

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-5">
            <CheckoutForm
              isLoggedIn={Boolean(user)}
              labels={t.checkout}
              defaults={
                savedAddress
                  ? {
                      fullName: savedAddress.fullName,
                      phone: savedAddress.phone,
                      province: savedAddress.province,
                      city: savedAddress.city,
                      addressLine1: savedAddress.addressLine1,
                      addressLine2: savedAddress.addressLine2 ?? "",
                      postalCode: savedAddress.postalCode ?? "",
                      nationalAddress: savedAddress.nationalAddr ?? "",
                    }
                  : undefined
              }
            />
          </div>

          <div>
            <Card className="sticky top-20 p-5">
              <p className="mb-4 font-semibold">{t.cart.summary}</p>

              <ul className="mb-4 space-y-3 border-b border-[--color-border-app] pb-4">
                {summary.lines.map((l) => (
                  <li
                    key={`${l.aeProductId}|${l.skuAttr}`}
                    className="flex gap-3 text-sm"
                  >
                    <span className="size-12 shrink-0 overflow-hidden rounded bg-ink-100 dark:bg-ink-800">
                      {l.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={l.imageUrl} alt="" className="size-full object-cover" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-xs leading-relaxed">
                        {l.title}
                      </span>
                      <span className="nums mt-0.5 block text-xs text-ink-500">
                        {l.variantLabel} × {l.quantity}
                      </span>
                    </span>
                    <span className="nums shrink-0 text-xs font-medium">
                      {formatSar(l.linePriceSar, locale)}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="space-y-2 text-sm">
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
                <div className="flex justify-between border-t border-[--color-border-app] pt-3 text-base font-bold">
                  <dt>{t.cart.total}</dt>
                  <dd className="nums">{formatSar(summary.totalSar, locale)}</dd>
                </div>
              </dl>

              {summary.maxDeliveryDays != null && (
                <p className="mt-4 text-xs leading-relaxed text-ink-500">
                  {fill(t.checkout.deliveryNote, { n: summary.maxDeliveryDays })}
                </p>
              )}
            </Card>
          </div>
        </div>

        <div className="mt-6">
          <Alert tone="info" title={t.checkout.paymentTitle}>
            {t.checkout.paymentBody}
          </Alert>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
