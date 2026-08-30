import { notFound } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { Alert, Card } from "@/components/ui";
import { OrderProgress, OrderStatusBadge } from "@/components/order-status";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { syncOrderIfStale } from "@/lib/order-sync";
import { formatSar } from "@/lib/pricing";
import { formatDateAr, formatSaudiPhone } from "@/lib/ksa";
import type { ShippingAddress } from "@/lib/ksa";

export const metadata = { title: "تفاصيل الطلب" };

interface TrackingNodeJson {
  title: string;
  description: string;
  at: string;
}

export default async function OrderDetailPage(
  props: PageProps<"/orders/[orderNumber]">,
) {
  const { orderNumber } = await props.params;
  const sp = await props.searchParams;
  const isNew = sp.new === "1";

  const user = await getCurrentUser();

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      items: true,
      aeOrders: { include: { packages: true } },
    },
  });

  if (!order) notFound();

  // الطلبيات المرتبطة بحساب لا يراها إلا صاحبها
  if (order.userId && order.userId !== user?.id) notFound();

  // استقصاء الحالة إن مضى وقت كافٍ — لا توجد إشعارات فورية في واجهات AliExpress
  await syncOrderIfStale(order.id);

  const fresh = await prisma.order.findUnique({
    where: { id: order.id },
    include: { items: true, aeOrders: { include: { packages: true } } },
  });
  const o = fresh ?? order;
  const addr = o.shippingSnapshot as unknown as ShippingAddress;

  const allPackages = o.aeOrders.flatMap((a) => a.packages);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        {isNew && (
          <div className="mb-6">
            <Alert tone="success" title="تم استلام طلبك">
              شكرًا لك. سنبدأ التجهيز فورًا وستصلك تحديثات التتبع هنا.
            </Alert>
          </div>
        )}

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold nums" dir="ltr">
              {o.orderNumber}
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              {formatDateAr(o.createdAt)}
            </p>
          </div>
          <OrderStatusBadge status={o.status} />
        </div>

        {o.status === "SOURCING_FAILED" && (
          <div className="mb-6">
            <Alert tone="warning" title="طلبك قيد المراجعة">
              واجهنا مشكلة أثناء تجهيز طلبك لدى المورّد. فريقنا يراجعها الآن
              وسيتواصل معك. لم يُخصم منك مبلغ إضافي.
            </Alert>
          </div>
        )}

        <Card className="mb-6 p-6">
          <OrderProgress status={o.status} />
        </Card>

        {/* التتبع */}
        {allPackages.length > 0 && (
          <Card className="mb-6 p-5">
            <p className="mb-4 font-semibold">تتبّع الشحنة</p>
            <div className="space-y-6">
              {allPackages.map((pkg) => {
                const nodes = (pkg.nodes as unknown as TrackingNodeJson[]) ?? [];
                return (
                  <div key={pkg.id}>
                    <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                      <span className="text-ink-500">رقم التتبع</span>
                      <code
                        className="rounded bg-[--color-background] px-2 py-1 font-mono text-xs nums"
                        dir="ltr"
                      >
                        {pkg.mailNo}
                      </code>
                      {pkg.cpWebsiteUrl && (
                        <a
                          href={pkg.cpWebsiteUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-xs text-brand-600 hover:underline"
                        >
                          تتبّع لدى {pkg.cpName ?? pkg.carrierName ?? "الناقل"} ↗
                        </a>
                      )}
                    </div>

                    {pkg.etaAt && (
                      <p className="mb-3 text-xs text-ink-500">
                        الوصول المتوقّع: {formatDateAr(pkg.etaAt)}
                      </p>
                    )}

                    <ol className="relative space-y-4 border-r-2 border-[--color-border-app] pr-5">
                      {nodes.map((n, i) => (
                        <li key={i} className="relative">
                          <span
                            className={
                              "absolute -right-[27px] top-1 size-3 rounded-full ring-4 ring-[--color-surface] " +
                              (i === 0 ? "bg-brand-600" : "bg-ink-300 dark:bg-ink-600")
                            }
                          />
                          <p className="text-sm font-medium">{n.title}</p>
                          {n.description && (
                            <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                              {n.description}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-ink-400">
                            {formatDateAr(n.at)}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {allPackages.length === 0 && o.status !== "PENDING_PAYMENT" && (
          <div className="mb-6">
            <Alert tone="info" title="لم تُشحن بعد">
              بيانات التتبع تظهر بعد أن يسلّم المورّد الشحنة إلى الناقل. عادةً
              خلال أيام قليلة من تأكيد الطلب.
            </Alert>
          </div>
        )}

        {/* المنتجات */}
        <Card className="mb-6 overflow-hidden">
          <p className="border-b border-[--color-border-app] px-5 py-3 font-semibold">
            المنتجات
          </p>
          <ul className="divide-y divide-[--color-border-app]">
            {o.items.map((it) => (
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
                  <p className="mt-1 text-xs text-ink-500 nums">
                    {it.variantLabel} · الكمية {it.quantity}
                  </p>
                  {it.shippingCompany && (
                    <p className="mt-0.5 text-xs text-ink-500">
                      {it.shippingCompany}
                      {it.minDeliveryDays && it.maxDeliveryDays
                        ? ` · ${it.minDeliveryDays}–${it.maxDeliveryDays} يوم`
                        : ""}
                    </p>
                  )}
                </div>
                <p className="shrink-0 text-sm font-semibold nums">
                  {formatSar(Number(it.unitPriceSar) * it.quantity)}
                </p>
              </li>
            ))}
          </ul>
        </Card>

        <div className="grid gap-6 sm:grid-cols-2">
          {/* العنوان */}
          <Card className="p-5">
            <p className="mb-3 font-semibold">عنوان الشحن</p>
            <address className="space-y-1 text-sm not-italic leading-relaxed text-ink-600 dark:text-ink-300">
              <p className="font-medium text-[--color-foreground]">{addr.fullName}</p>
              <p dir="ltr" className="text-right nums">
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
                  العنوان الوطني: <span className="nums">{addr.nationalAddress}</span>
                </p>
              )}
            </address>
          </Card>

          {/* المبالغ */}
          <Card className="p-5">
            <p className="mb-3 font-semibold">ملخّص المبالغ</p>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-500">المجموع الفرعي</dt>
                <dd className="nums">{formatSar(Number(o.subtotalSar))}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">الشحن</dt>
                <dd className="nums">{formatSar(Number(o.shippingSar))}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">ضريبة القيمة المضافة</dt>
                <dd className="nums">{formatSar(Number(o.vatSar))}</dd>
              </div>
              <div className="flex justify-between border-t border-[--color-border-app] pt-2 font-bold">
                <dt>الإجمالي</dt>
                <dd className="nums">{formatSar(Number(o.totalSar))}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
