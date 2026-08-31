import { notFound } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { Alert, Card } from "@/components/ui";
import { OrderTracking } from "@/components/order-tracking";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { syncOrderIfStale } from "@/lib/order-sync";
import { formatSar } from "@/lib/pricing";
import { formatDateAr, formatSaudiPhone } from "@/lib/ksa";
import type { ShippingAddress } from "@/lib/ksa";
import { getDictionary, getLocale } from "@/lib/i18n";
import { getQueryClient } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import type { OrderTrackingDto, TrackingNodeDto } from "@/lib/query/keys";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.orders.detailTitle };
}

export default async function OrderDetailPage(
  props: PageProps<"/orders/[orderNumber]">,
) {
  const { orderNumber } = await props.params;
  const sp = await props.searchParams;
  const isNew = sp.new === "1";

  const [user, t, locale] = await Promise.all([
    getCurrentUser(),
    getDictionary(),
    getLocale(),
  ]);

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: { items: true },
  });

  if (!order) notFound();

  // الطلبيات المرتبطة بحساب لا يراها إلا صاحبها
  if (order.userId && order.userId !== user?.id) notFound();

  // استقصاء أولي إن مضى الفاصل الأدنى، ثم يتولّى العميل التحديث الدوري
  await syncOrderIfStale(order.id);

  const fresh = await prisma.order.findUnique({
    where: { id: order.id },
    select: {
      status: true,
      aeOrders: {
        select: {
          packages: {
            select: {
              mailNo: true,
              carrierName: true,
              cpName: true,
              cpWebsiteUrl: true,
              etaAt: true,
              nodes: true,
            },
          },
        },
      },
    },
  });

  const initialTracking: OrderTrackingDto = {
    status: fresh?.status ?? order.status,
    packages: (fresh?.aeOrders ?? []).flatMap((ae) =>
      ae.packages.map((p) => ({
        mailNo: p.mailNo,
        carrierName: p.carrierName,
        cpName: p.cpName,
        cpWebsiteUrl: p.cpWebsiteUrl,
        etaAt: p.etaAt?.toISOString() ?? null,
        nodes: ((p.nodes as unknown as TrackingNodeDto[]) ?? []).map((n) => ({
          title: n.title,
          description: n.description,
          at: typeof n.at === "string" ? n.at : new Date(n.at).toISOString(),
        })),
      })),
    ),
    updatedAt: new Date().toISOString(),
  };

  // ترطيب الحالة الأولية حتى لا يظهر وميض تحميل قبل أول استقصاء
  const queryClient = getQueryClient();
  queryClient.setQueryData(queryKeys.orderTracking(orderNumber), initialTracking);

  const addr = order.shippingSnapshot as unknown as ShippingAddress;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        {isNew && (
          <div className="mb-6">
            <Alert tone="success" title={t.orders.newOrderTitle}>
              {t.orders.newOrderBody}
            </Alert>
          </div>
        )}

        <div className="mb-6">
          <h1 className="nums text-2xl font-bold" dir="ltr">
            {order.orderNumber}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {formatDateAr(order.createdAt, locale)}
          </p>
        </div>

        <HydrationBoundary state={dehydrate(queryClient)}>
          <OrderTracking
            orderNumber={orderNumber}
            initialData={initialTracking}
            locale={locale}
            labels={t.orders}
            steps={t.orders.steps}
            statusLabels={t.orders.status}
          />
        </HydrationBoundary>

        <Card className="mb-6 overflow-hidden">
          <p className="border-b border-[--color-border-app] px-5 py-3 font-semibold">
            {t.orders.products}
          </p>
          <ul className="divide-y divide-[--color-border-app]">
            {order.items.map((it) => (
              <li key={it.id} className="flex gap-4 p-4">
                <span className="size-16 shrink-0 overflow-hidden rounded-lg bg-ink-100 dark:bg-ink-800">
                  {it.imageSnapshot && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={it.imageSnapshot}
                      alt=""
                      className="size-full object-cover"
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm">{it.titleSnapshot}</p>
                  <p className="nums mt-1 text-xs text-ink-500">
                    {it.variantLabel} · {t.orders.quantityLabel} {it.quantity}
                  </p>
                  {it.shippingCompany && (
                    <p className="mt-0.5 text-xs text-ink-500">
                      {it.shippingCompany}
                      {it.minDeliveryDays && it.maxDeliveryDays
                        ? ` · ${it.minDeliveryDays}–${it.maxDeliveryDays}`
                        : ""}
                    </p>
                  )}
                </div>
                <p className="nums shrink-0 text-sm font-semibold">
                  {formatSar(Number(it.unitPriceSar) * it.quantity, locale)}
                </p>
              </li>
            ))}
          </ul>
        </Card>

        <div className="grid gap-6 sm:grid-cols-2">
          <Card className="p-5">
            <p className="mb-3 font-semibold">{t.checkout.shippingAddress}</p>
            <address className="space-y-1 text-sm not-italic leading-relaxed text-ink-600 dark:text-ink-300">
              <p className="font-medium text-[--color-foreground]">{addr.fullName}</p>
              <p dir="ltr" className="nums">
                {formatSaudiPhone(addr.phone)}
              </p>
              <p>{addr.addressLine1}</p>
              {addr.addressLine2 && <p>{addr.addressLine2}</p>}
              <p>
                {addr.city}، {addr.province}
                {addr.postalCode && <span className="nums"> {addr.postalCode}</span>}
              </p>
              {addr.nationalAddress && (
                <p className="text-xs text-ink-500">
                  {t.account.nationalAddressLabel}:{" "}
                  <span className="nums">{addr.nationalAddress}</span>
                </p>
              )}
            </address>
          </Card>

          <Card className="p-5">
            <p className="mb-3 font-semibold">{t.orders.amountSummary}</p>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-500">{t.cart.subtotal}</dt>
                <dd className="nums">{formatSar(Number(order.subtotalSar), locale)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">{t.cart.shipping}</dt>
                <dd className="nums">{formatSar(Number(order.shippingSar), locale)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">{t.cart.vat}</dt>
                <dd className="nums">{formatSar(Number(order.vatSar), locale)}</dd>
              </div>
              <div className="flex justify-between border-t border-[--color-border-app] pt-2 font-bold">
                <dt>{t.cart.total}</dt>
                <dd className="nums">{formatSar(Number(order.totalSar), locale)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
