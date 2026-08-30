import { notFound } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Card } from "@/components/ui";
import { OrderStatusBadge } from "@/components/order-status";
import { RetrySourcingButton } from "@/components/retry-sourcing";
import { prisma } from "@/lib/db";
import { formatSar } from "@/lib/pricing";
import { formatDateAr, formatSaudiPhone } from "@/lib/ksa";
import type { ShippingAddress } from "@/lib/ksa";

export const metadata = { title: "تفاصيل الطلبية · الإدارة" };

export default async function AdminOrderPage(
  props: PageProps<"/admin/orders/[orderNumber]">,
) {
  const { orderNumber } = await props.params;

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      items: true,
      user: { select: { name: true, email: true } },
      aeOrders: { include: { packages: true } },
    },
  });

  if (!order) notFound();

  const logs = await prisma.aeApiLog.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const addr = order.shippingSnapshot as unknown as ShippingAddress;
  const costSar =
    (Number(order.costSubtotal) + Number(order.costShipping)) *
    Number(order.fxRateUsed);
  const margin = Number(order.totalSar) - costSar;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/admin/orders" className="text-sm text-ink-500 hover:text-brand-600">
            ← الطلبيات
          </Link>
          <h1 className="mt-1 text-2xl font-bold nums" dir="ltr">
            {order.orderNumber}
          </h1>
          <p className="mt-1 text-sm text-ink-500">{formatDateAr(order.createdAt)}</p>
        </div>
        <div className="flex items-center gap-3">
          <OrderStatusBadge status={order.status} />
          {order.status === "SOURCING_FAILED" && (
            <RetrySourcingButton orderId={order.id} />
          )}
        </div>
      </div>

      {order.status === "SOURCING_FAILED" && (
        <div className="mb-6">
          <Alert tone="danger" title="فشل التوريد من AliExpress">
            راجع سجل الاستدعاءات أسفل الصفحة لمعرفة رمز الخطأ. أعد المحاولة فقط
            إن كان الخطأ قابلًا لذلك — الأخطاء من فئة A001–A006 تتطلّب التواصل
            مع الدعم الفني لدى المنصة.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* المنتجات */}
          <Card className="overflow-hidden">
            <p className="border-b border-[--color-border-app] px-5 py-3 font-semibold">
              المنتجات
            </p>
            <ul className="divide-y divide-[--color-border-app]">
              {order.items.map((it) => (
                <li key={it.id} className="p-4">
                  <div className="flex gap-4">
                    <span className="size-14 shrink-0 overflow-hidden rounded-lg bg-ink-100 dark:bg-ink-800">
                      {it.imageSnapshot && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={it.imageSnapshot} alt="" className="size-full object-cover" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="line-clamp-2">{it.titleSnapshot}</p>
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-ink-500 sm:grid-cols-2">
                        <div className="flex gap-2">
                          <dt>معرّف المنتج:</dt>
                          <dd className="nums" dir="ltr">{it.aeProductId}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt>الكمية:</dt>
                          <dd className="nums">{it.quantity}</dd>
                        </div>
                        <div className="flex gap-2 sm:col-span-2">
                          <dt className="shrink-0">skuAttr:</dt>
                          <dd className="truncate font-mono" dir="ltr" title={it.skuAttr}>
                            {it.skuAttr}
                          </dd>
                        </div>
                        <div className="flex gap-2 sm:col-span-2">
                          <dt className="shrink-0">خدمة الشحن:</dt>
                          <dd className="font-mono" dir="ltr">{it.logisticsServiceName}</dd>
                        </div>
                      </dl>
                    </div>
                    <div className="shrink-0 text-left text-sm">
                      <p className="font-semibold nums">
                        {formatSar(Number(it.unitPriceSar) * it.quantity)}
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
            <p className="border-b border-[--color-border-app] px-5 py-3 font-semibold">
              طلبيات AliExpress
              <span className="mr-2 text-xs font-normal text-ink-500">
                (طلبية واحدة لدينا قد تنقسم على عدة بائعين)
              </span>
            </p>
            {order.aeOrders.length === 0 ? (
              <p className="p-5 text-sm text-ink-500">لم تُصدَّر بعد.</p>
            ) : (
              <ul className="divide-y divide-[--color-border-app]">
                {order.aeOrders.map((ae) => (
                  <li key={ae.id} className="p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <code className="rounded bg-[--color-background] px-2 py-1 font-mono text-xs nums" dir="ltr">
                        {ae.aeOrderId}
                      </code>
                      {ae.aeOrderStatus && <Badge tone="info">{ae.aeOrderStatus}</Badge>}
                      {ae.aeLogisticsStatus && (
                        <Badge tone="neutral">{ae.aeLogisticsStatus}</Badge>
                      )}
                      {ae.payTimeoutSecond != null && ae.payTimeoutSecond > 0 && (
                        <Badge tone="warning">
                          مهلة الدفع: {Math.floor(ae.payTimeoutSecond / 60)} دقيقة
                        </Badge>
                      )}
                    </div>
                    {ae.lastPolledAt && (
                      <p className="mt-2 text-xs text-ink-500">
                        آخر استقصاء: {formatDateAr(ae.lastPolledAt)}
                      </p>
                    )}
                    {ae.packages.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {ae.packages.map((p) => (
                          <li key={p.id} className="text-xs text-ink-500">
                            تتبع:{" "}
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

          {/* سجل الاستدعاءات */}
          <Card className="overflow-hidden">
            <p className="border-b border-[--color-border-app] px-5 py-3 font-semibold">
              سجل استدعاءات الواجهات
            </p>
            {logs.length === 0 ? (
              <p className="p-5 text-sm text-ink-500">لا توجد سجلات.</p>
            ) : (
              <ul className="divide-y divide-[--color-border-app] text-sm">
                {logs.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-3 p-3">
                    <Badge tone={l.success ? "success" : "danger"}>
                      {l.success ? "نجح" : "فشل"}
                    </Badge>
                    <code className="font-mono text-xs" dir="ltr">{l.apiName}</code>
                    {l.errorCode && (
                      <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200" dir="ltr">
                        {l.errorCode}
                      </code>
                    )}
                    {l.retryable === false && !l.success && (
                      <Badge tone="danger">غير قابل لإعادة المحاولة</Badge>
                    )}
                    <span className="mr-auto text-xs text-ink-500 nums">
                      {l.durationMs} م.ث · {formatDateAr(l.createdAt)}
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
            <p className="mb-3 font-semibold">الربحية</p>
            <dl className="space-y-2 text-sm">
              <Row label="الإيراد" value={formatSar(Number(order.totalSar))} />
              <Row label="التكلفة" value={formatSar(costSar)} muted />
              <Row
                label="الهامش"
                value={formatSar(margin)}
                tone={margin >= 0 ? "success" : "danger"}
              />
              <div className="border-t border-[--color-border-app] pt-2">
                <Row
                  label="سعر الصرف المثبَّت"
                  value={Number(order.fxRateUsed).toFixed(4)}
                  muted
                />
                <Row
                  label="التكلفة بالمصدر"
                  value={`$${(Number(order.costSubtotal) + Number(order.costShipping)).toFixed(2)}`}
                  muted
                />
              </div>
            </dl>
          </Card>

          <Card className="p-5">
            <p className="mb-3 font-semibold">العميل</p>
            {order.user ? (
              <div className="text-sm">
                <p>{order.user.name}</p>
                <p className="text-ink-500" dir="ltr">{order.user.email}</p>
              </div>
            ) : (
              <p className="text-sm text-ink-500">زائر (بلا حساب)</p>
            )}
          </Card>

          <Card className="p-5">
            <p className="mb-3 font-semibold">عنوان الشحن</p>
            <address className="space-y-1 text-sm not-italic leading-relaxed text-ink-600 dark:text-ink-300">
              <p className="font-medium text-[--color-foreground]">{addr.fullName}</p>
              <p dir="ltr" className="text-right nums">{formatSaudiPhone(addr.phone)}</p>
              <p>{addr.addressLine1}</p>
              {addr.addressLine2 && <p>{addr.addressLine2}</p>}
              <p>
                {addr.city}، {addr.province}
                {addr.postalCode && <span className="nums"> {addr.postalCode}</span>}
              </p>
              {addr.nationalAddress && (
                <p className="text-xs">
                  العنوان الوطني:{" "}
                  <code className="nums" dir="ltr">{addr.nationalAddress}</code>
                </p>
              )}
            </address>
          </Card>

          <Card className="p-5">
            <p className="mb-2 font-semibold">مفتاح منع التكرار</p>
            <code className="block break-all rounded bg-[--color-background] p-2 font-mono text-xs" dir="ltr">
              {order.outOrderId}
            </code>
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              يُرسَل في الحقل out_order_id، وإعادة الإرسال به تُرفض بـ
              REPEATED_ORDER_ERROR بدل الشراء مرتين.
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
