import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { Card, Badge, Alert } from "@/components/ui";
import { prisma } from "@/lib/db";
import { recognizedOrderFinancials } from "@/lib/admin-stats";
import { env } from "@/lib/env";
import { formatSar, effectiveFxRate } from "@/lib/pricing";
import { formatDateAr } from "@/lib/ksa";
import { OrderStatusBadge } from "@/components/order-status";
import { fill, getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.nav.admin };
}

export default async function AdminHome() {
  // حارس ذاتي — لا يُكتفى بحماية التخطيط (راجع requireAdmin). يسبق كل قراءة.
  await requireAdmin();
  const cfg = env();
  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

  const [
    totalOrders,
    needsAttention,
    financials,
    recentOrders,
    failedCalls,
    fatalCalls,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { needsManualReview: true } }),
    recognizedOrderFinancials(),
    prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalSar: true,
        createdAt: true,
        _count: { select: { items: true, aeOrders: true } },
      },
    }),
    prisma.aeApiLog.count({ where: { success: false } }),
    prisma.aeApiLog.count({ where: { success: false, retryable: false } }),
  ]);

  const totalRevenue = financials.revenueSar;
  const grossMargin = financials.grossMarginSar;

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold">{t.admin.overview}</h1>

      {cfg.AE_MODE === "mock" && (
        <div className="mb-6">
          <Alert tone="warning" title={t.admin.mockModeTitle}>
            {t.admin.mockModeBody}
          </Alert>
        </div>
      )}

      {needsAttention > 0 && (
        <div className="mb-6">
          <Alert tone="danger" title={fill(t.admin.needsAttention, { n: needsAttention })}>
            <Link href="/admin/orders?review=true" className="underline">
              {t.admin.needsAttentionBody}
            </Link>
          </Alert>
        </div>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t.admin.totalOrders} value={String(totalOrders)} />
        <Stat label={t.admin.revenue} value={formatSar(totalRevenue, locale)} />
        <Stat
          label={t.admin.grossMargin}
          value={formatSar(grossMargin, locale)}
          tone={grossMargin >= 0 ? "success" : "danger"}
        />
        <Stat
          label={t.admin.failedCalls}
          value={String(failedCalls)}
          hint={fatalCalls > 0 ? fill(t.admin.notRetryable, { n: fatalCalls }) : undefined}
          tone={fatalCalls > 0 ? "danger" : "neutral"}
        />
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-ink-500">{t.admin.integrationMode}</p>
          <p className="mt-1 font-semibold">
            <Badge tone={cfg.AE_MODE === "live" ? "success" : "warning"}>
              {cfg.AE_MODE === "live" ? t.admin.live : t.admin.mock}
            </Badge>
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{t.admin.fxRate}</p>
          <p className="mt-1 font-semibold nums">
            {effectiveFxRate().toFixed(4)} {t.admin.fxRateUnit}
          </p>
          <p className="mt-0.5 text-xs text-ink-500 nums">
            {fill(t.admin.fxRateBase, { base: cfg.FX_USD_TO_SAR, buffer: cfg.FX_BUFFER_PERCENT })}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{t.admin.defaultMargin}</p>
          <p className="mt-1 font-semibold nums">{cfg.DEFAULT_MARGIN_PERCENT}%</p>
          <p className="mt-0.5 text-xs text-ink-500 nums">
            {fill(t.admin.vatLabel, { n: cfg.VAT_PERCENT })}
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-(--color-border-app) px-5 py-3">
          <p className="font-semibold">{t.admin.recentOrders}</p>
          <Link href="/admin/orders" className="text-sm text-brand-600 hover:underline">
            {t.home.viewAll}
          </Link>
        </div>

        {recentOrders.length === 0 ? (
          <p className="p-8 text-center text-sm text-ink-500">{t.admin.noOrders}</p>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-(--color-background) text-xs text-ink-500">
                <tr>
                  <th className="px-5 py-2.5 text-right font-medium">{t.admin.colOrderNumber}</th>
                  <th className="px-5 py-2.5 text-right font-medium">{t.admin.colDate}</th>
                  <th className="px-5 py-2.5 text-right font-medium">{t.admin.colProducts}</th>
                  <th className="px-5 py-2.5 text-right font-medium">{t.admin.colAeOrders}</th>
                  <th className="px-5 py-2.5 text-right font-medium">{t.admin.colTotal}</th>
                  <th className="px-5 py-2.5 text-right font-medium">{t.admin.colStatus}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-(--color-border-app)">
                {recentOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-(--color-background)">
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/orders/${o.orderNumber}`}
                        className="font-medium text-brand-600 hover:underline nums"
                        dir="ltr"
                      >
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-ink-500">
                      {formatDateAr(o.createdAt, locale)}
                    </td>
                    <td className="px-5 py-3 nums">{o._count.items}</td>
                    <td className="px-5 py-3 nums">{o._count.aeOrders}</td>
                    <td className="px-5 py-3 font-medium nums">
                      {formatSar(Number(o.totalSar), locale)}
                    </td>
                    <td className="px-5 py-3">
                      <OrderStatusBadge status={o.status} labels={t.orders.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "danger";
}) {
  const color =
    tone === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "danger"
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <Card className="p-5">
      <p className="text-sm text-ink-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold nums ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </Card>
  );
}
