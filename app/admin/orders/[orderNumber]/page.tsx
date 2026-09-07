import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import Link from "next/link";
import { Alert, Badge, Card } from "@/components/ui";
import { OrderStatusBadge } from "@/components/order-status";
import { RetrySourcingButton } from "@/components/retry-sourcing";
import { AdminOrderActions } from "@/components/admin-order-actions";
import { prisma } from "@/lib/db";
import { activeProvider } from "@/lib/payments";
import { formatSar } from "@/lib/pricing";
import { formatDateAr, formatSaudiPhone, shippingAddressSchema } from "@/lib/ksa";
import { fill, getDictionary, getLocale } from "@/lib/i18n";
import { isOrderNumber } from "@/lib/order-number";

/** ألوان شارات حالة الدفع — النهائية الناجحة خضراء والفاشلة حمراء. */
const PAYMENT_TONES: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  REQUIRES_ACTION: "warning",
  PENDING: "info",
  PAID: "success",
  FAILED: "danger",
  EXPIRED: "neutral",
  REFUNDED: "neutral",
};

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.orders.detailTitle };
}

export default async function AdminOrderPage(
  props: PageProps<"/admin/orders/[orderNumber]">,
) {
  // حارس ذاتي — لا يُكتفى بحماية التخطيط (راجع requireAdmin). يسبق كل قراءة.
  await requireAdmin();
  const { orderNumber } = await props.params;
  if (!isOrderNumber(orderNumber)) notFound();
  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      items: true,
      user: { select: { name: true, email: true } },
      aeOrders: { include: { packages: true } },
      // الأحدث أولًا: محاولة الدفع الأخيرة هي المعنيّة دائمًا
      payments: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!order) notFound();

  const parsedAddress = shippingAddressSchema.safeParse(order.shippingSnapshot);
  if (!parsedAddress.success) notFound();

  const logs = await prisma.aeApiLog.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const addr = parsedAddress.data;
  const costSar =
    (Number(order.costSubtotal) + Number(order.costShipping)) *
    Number(order.fxRateUsed);
  const margin = Number(order.totalSar) - costSar;

  // التأكيد اليدوي يخصّ المزوّد «يدوي» وحده، ولا يُعرض إلا لمحاولة ما زالت
  // مفتوحة — تأكيد محاولة منتهية أو مدفوعة يخلق ازدواج تحصيل.
  const settleableIntent =
    activeProvider() === "manual"
      ? (order.payments.find(
          (p) => p.status === "REQUIRES_ACTION" || p.status === "PENDING",
        ) ?? null)
      : null;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/admin/orders" className="text-sm text-ink-500 hover:text-brand-600">
            {t.admin.orders}
          </Link>
          <h1 className="mt-1 text-2xl font-bold nums" dir="ltr">
            {order.orderNumber}
          </h1>
          <p className="mt-1 text-sm text-ink-500">{formatDateAr(order.createdAt, locale)}</p>
        </div>
        <div className="flex items-center gap-3">
          <OrderStatusBadge status={order.status} labels={t.orders.status} />
          {order.status === "SOURCING_FAILED" && (
            <RetrySourcingButton orderId={order.id} labels={{ retry: t.admin.retrySourcing, retrying: t.admin.retrying }} />
          )}
          <AdminOrderActions
            orderId={order.id}
            settleableIntentId={settleableIntent?.id ?? null}
            labels={{
              cancelCta: t.admin.cancelOrderCta,
              cancelTitle: t.admin.cancelOrderTitle,
              cancelBody: t.admin.cancelOrderBody,
              cancelReason: t.admin.cancelOrderReason,
              cancelConfirm: t.admin.cancelOrderConfirm,
              cancelling: t.orders.cancelling,
              close: t.common.cancel,
              confirmPayment: t.admin.confirmPayment,
              confirmingPayment: t.admin.confirmingPayment,
            }}
          />
        </div>
      </div>

      {order.status === "SOURCING_FAILED" && (
        <div className="mb-6">
          <Alert tone="danger" title={t.admin.sourcingFailedTitle}>
            {t.admin.sourcingFailedBody}
          </Alert>
        </div>
      )}

      {order.status === "CANCELLED" && (
        <div className="mb-6">
          <Alert tone="warning" title={t.admin.orderCancelled}>
            {order.cancelledAt && (
              <p className="nums">
                {fill(t.orders.cancelledAt, {
                  date: formatDateAr(order.cancelledAt, locale),
                })}
              </p>
            )}
            {order.cancelReason && (
              <p className="mt-1 text-xs" dir="auto">
                {t.orders.cancelReason}: {order.cancelReason}
              </p>
            )}
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* المنتجات */}
          <Card className="overflow-hidden">
            <p className="border-b border-(--color-border-app) px-5 py-3 font-semibold">
              {t.orders.products}
            </p>
            <ul className="divide-y divide-(--color-border-app)">
              {order.items.map((it) => (
                <li key={it.id} className="p-4">
                  <div className="flex gap-4">
                    <span className="size-14 shrink-0 overflow-hidden rounded-lg bg-ink-100 dark:bg-ink-800">
                      {it.imageSnapshot && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={it.imageSnapshot}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="size-full object-cover"
                        />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="line-clamp-2">{it.titleSnapshot}</p>
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-ink-500 sm:grid-cols-2">
                        <div className="flex gap-2">
                          <dt>{t.admin.productId}:</dt>
                          <dd className="nums" dir="ltr">{it.aeProductId}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt>{t.orders.quantityLabel}:</dt>
                          <dd className="nums">{it.quantity}</dd>
                        </div>
                        <div className="flex gap-2 sm:col-span-2">
                          <dt className="shrink-0">skuAttr:</dt>
                          <dd className="truncate font-mono" dir="ltr" title={it.skuAttr}>
                            {it.skuAttr}
                          </dd>
                        </div>
                        <div className="flex gap-2 sm:col-span-2">
                          <dt className="shrink-0">{t.admin.shippingService}:</dt>
                          <dd className="font-mono" dir="ltr">{it.logisticsServiceName}</dd>
                        </div>
                      </dl>
                    </div>
                    <div className="shrink-0 text-left text-sm">
                      <p className="font-semibold nums">
                        {formatSar(Number(it.unitPriceSar) * it.quantity, locale)}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-500 nums" dir="ltr">
                        ${Number(it.unitCostSource).toFixed(2)} × {it.quantity}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          {/* طلبيات AliExpress */}
          <Card className="overflow-hidden">
            <p className="border-b border-(--color-border-app) px-5 py-3 font-semibold">
              {t.admin.aeOrders}
              <span className="ms-2 text-xs font-normal text-ink-500">
                {t.admin.aeOrdersNote}
              </span>
            </p>
            {order.aeOrders.length === 0 ? (
              <p className="p-5 text-sm text-ink-500">{t.admin.notSourced}</p>
            ) : (
              <ul className="divide-y divide-(--color-border-app)">
                {order.aeOrders.map((ae) => (
                  <li key={ae.id} className="p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <code className="rounded bg-(--color-background) px-2 py-1 font-mono text-xs nums" dir="ltr">
                        {ae.aeOrderId}
                      </code>
                      {ae.aeOrderStatus && <Badge tone="info">{ae.aeOrderStatus}</Badge>}
                      {ae.aeLogisticsStatus && (
                        <Badge tone="neutral">{ae.aeLogisticsStatus}</Badge>
                      )}
                      {ae.payTimeoutSecond != null && ae.payTimeoutSecond > 0 && (
                        <Badge tone="warning">
                          {fill(t.admin.payTimeout, { n: Math.floor(ae.payTimeoutSecond / 60) })}
                        </Badge>
                      )}
                    </div>
                    {ae.lastPolledAt && (
                      <p className="mt-2 text-xs text-ink-500">
                        {fill(t.admin.lastPolled, { date: formatDateAr(ae.lastPolledAt, locale) })}
                      </p>
                    )}
                    {ae.packages.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {ae.packages.map((p) => (
                          <li key={p.id} className="text-xs text-ink-500">
                            {t.admin.trackingLabel}:{" "}
                            <code className="nums" dir="ltr">{p.mailNo}</code>
                            {p.carrierName && ` · ${p.carrierName}`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* محاولات الدفع */}
          <Card className="overflow-hidden">
            <p className="border-b border-(--color-border-app) px-5 py-3 font-semibold">
              {t.admin.paymentIntents}
            </p>
            {order.payments.length === 0 ? (
              <p className="p-5 text-sm text-ink-500">{t.admin.noPayments}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-(--color-border-app) text-xs text-ink-500">
                    <tr>
                      <th className="px-4 py-2 text-start font-medium">
                        {t.admin.colProvider}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t.admin.colRef}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t.admin.colAmount}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t.admin.colStatus}
                      </th>
                      <th className="px-4 py-2 text-start font-medium">
                        {t.admin.colDate}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-(--color-border-app)">
                    {order.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="px-4 py-2">{p.provider}</td>
                        <td className="px-4 py-2">
                          <code className="font-mono text-xs nums" dir="ltr">
                            {p.providerRef}
                          </code>
                        </td>
                        <td className="px-4 py-2 nums">
                          {formatSar(Number(p.amountSar), locale)}
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone={PAYMENT_TONES[p.status] ?? "neutral"}>
                            {t.payment.status[p.status]}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-xs text-ink-500 nums">
                          {formatDateAr(p.createdAt, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* سجل الاستدعاءات */}
          <Card className="overflow-hidden">
            <p className="border-b border-(--color-border-app) px-5 py-3 font-semibold">
              {t.admin.apiCallLog}
            </p>
            {logs.length === 0 ? (
              <p className="p-5 text-sm text-ink-500">{t.admin.noLogs}</p>
            ) : (
              <ul className="divide-y divide-(--color-border-app) text-sm">
                {logs.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-3 p-3">
                    <Badge tone={l.success ? "success" : "danger"}>
                      {l.success ? t.admin.succeeded : t.admin.failed}
                    </Badge>
                    <code className="font-mono text-xs" dir="ltr">{l.apiName}</code>
                    {l.errorCode && (
                      <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200" dir="ltr">
                        {l.errorCode}
                      </code>
                    )}
                    {l.retryable === false && !l.success && (
                      <Badge tone="danger">{t.admin.notRetryableBadge}</Badge>
                    )}
                    <span className="mr-auto text-xs text-ink-500 nums">
                      {l.durationMs} {t.admin.ms} · {formatDateAr(l.createdAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* الجانب */}
        <div className="space-y-6">
          <Card className="p-5">
            <p className="mb-3 font-semibold">{t.admin.profitability}</p>
            <dl className="space-y-2 text-sm">
              <Row label={t.admin.revenueLabel} value={formatSar(Number(order.totalSar), locale)} />
              <Row label={t.admin.costLabel} value={formatSar(costSar, locale)} muted />
              <Row
                label="الهامش"
                value={formatSar(margin)}
                tone={margin >= 0 ? "success" : "danger"}
              />
              <div className="border-t border-(--color-border-app) pt-2">
                <Row
                  label={t.admin.fxLocked}
                  value={Number(order.fxRateUsed).toFixed(4)}
                  muted
                />
                <Row
                  label={t.admin.costSource}
                  value={`$${(Number(order.costSubtotal) + Number(order.costShipping)).toFixed(2)}`}
                  muted
                />
              </div>
            </dl>
          </Card>

          <Card className="p-5">
            <p className="mb-3 font-semibold">{t.admin.customer}</p>
            {order.user ? (
              <div className="text-sm">
                <p>{order.user.name}</p>
                <p className="text-ink-500" dir="ltr">{order.user.email}</p>
              </div>
            ) : (
              <p className="text-sm text-ink-500">{t.admin.guest}</p>
            )}
          </Card>

          <Card className="p-5">
            <p className="mb-3 font-semibold">{t.checkout.shippingAddress}</p>
            <address className="space-y-1 text-sm not-italic leading-relaxed text-ink-600 dark:text-ink-300">
              <p className="font-medium text-(--color-foreground)">{addr.fullName}</p>
              <p dir="ltr" className="text-right nums">{formatSaudiPhone(addr.phone)}</p>
              <p>{addr.addressLine1}</p>
              {addr.addressLine2 && <p>{addr.addressLine2}</p>}
              <p>
                {addr.city}، {addr.province}
                {addr.postalCode && <span className="nums"> {addr.postalCode}</span>}
              </p>
              {addr.nationalAddress && (
                <p className="text-xs">
                  {t.account.nationalAddressLabel}:{" "}
                  <code className="nums" dir="ltr">{addr.nationalAddress}</code>
                </p>
              )}
            </address>
          </Card>

          <Card className="p-5">
            <p className="mb-2 font-semibold">{t.admin.idempotencyKey}</p>
            <code className="block break-all rounded bg-(--color-background) p-2 font-mono text-xs" dir="ltr">
              {order.outOrderId}
            </code>
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              {t.admin.idempotencyNote}
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "success" | "danger";
}) {
  const color =
    tone === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "danger"
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <div className="flex justify-between">
      <dt className={muted ? "text-ink-500" : ""}>{label}</dt>
      <dd className={`nums font-medium ${color}`}>{value}</dd>
    </div>
  );
}
