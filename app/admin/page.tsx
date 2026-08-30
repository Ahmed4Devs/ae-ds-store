import Link from "next/link";
import { Card, Badge, Alert } from "@/components/ui";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { formatSar, effectiveFxRate } from "@/lib/pricing";
import { formatDateAr } from "@/lib/ksa";
import { OrderStatusBadge } from "@/components/order-status";

export const metadata = { title: "لوحة الإدارة" };

export default async function AdminHome() {
  const cfg = env();

  const [
    totalOrders,
    needsAttention,
    revenue,
    recentOrders,
    failedCalls,
    fatalCalls,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: "SOURCING_FAILED" } }),
    prisma.order.aggregate({
      _sum: { totalSar: true, costSubtotal: true, costShipping: true },
      where: { status: { in: ["SOURCED", "SHIPPED", "DELIVERED"] } },
    }),
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

  const totalRevenue = Number(revenue._sum.totalSar ?? 0);
  const totalCostSource =
    Number(revenue._sum.costSubtotal ?? 0) + Number(revenue._sum.costShipping ?? 0);
  const totalCostSar = totalCostSource * effectiveFxRate();
  const grossMargin = totalRevenue - totalCostSar;

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold">نظرة عامة</h1>

      {cfg.AE_MODE === "mock" && (
        <div className="mb-6">
          <Alert tone="warning" title="وضع المحاكاة نشط">
            جميع الطلبيات وهمية ولا تُشترى فعليًا من AliExpress. اضبط
            <code className="mx-1 rounded bg-amber-200/40 px-1">AE_MODE=live</code>
            مع مفاتيح التطبيق ورمز الوصول للتشغيل الحقيقي.
          </Alert>
        </div>
      )}

      {needsAttention > 0 && (
        <div className="mb-6">
          <Alert tone="danger" title={`${needsAttention} طلبية تحتاج تدخّلًا يدويًا`}>
            فشل توريدها من AliExpress. راجع{" "}
            <Link href="/admin/orders?status=SOURCING_FAILED" className="underline">
              قائمة الطلبيات
            </Link>{" "}
            وسجل الواجهات لمعرفة السبب.
          </Alert>
        </div>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="إجمالي الطلبيات" value={String(totalOrders)} />
        <Stat label="الإيرادات" value={formatSar(totalRevenue)} />
        <Stat
          label="الهامش الإجمالي"
          value={formatSar(grossMargin)}
          tone={grossMargin >= 0 ? "success" : "danger"}
        />
        <Stat
          label="استدعاءات فاشلة"
          value={String(failedCalls)}
          hint={fatalCalls > 0 ? `${fatalCalls} غير قابل لإعادة المحاولة` : undefined}
          tone={fatalCalls > 0 ? "danger" : "neutral"}
        />
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-ink-500">وضع التكامل</p>
          <p className="mt-1 font-semibold">
            <Badge tone={cfg.AE_MODE === "live" ? "success" : "warning"}>
              {cfg.AE_MODE === "live" ? "إنتاج" : "محاكاة"}
            </Badge>
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">سعر الصرف المطبَّق</p>
          <p className="mt-1 font-semibold nums">
            {effectiveFxRate().toFixed(4)} ريال / دولار
          </p>
          <p className="mt-0.5 text-xs text-ink-500 nums">
            الأساس {cfg.FX_USD_TO_SAR} + هامش {cfg.FX_BUFFER_PERCENT}٪
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">هامش الربح الافتراضي</p>
          <p className="mt-1 font-semibold nums">{cfg.DEFAULT_MARGIN_PERCENT}٪</p>
          <p className="mt-0.5 text-xs text-ink-500 nums">
            ضريبة القيمة المضافة {cfg.VAT_PERCENT}٪
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[--color-border-app] px-5 py-3">
          <p className="font-semibold">أحدث الطلبيات</p>
          <Link href="/admin/orders" className="text-sm text-brand-600 hover:underline">
            عرض الكل
          </Link>
        </div>

        {recentOrders.length === 0 ? (
          <p className="p-8 text-center text-sm text-ink-500">لا توجد طلبيات بعد</p>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-[--color-background] text-xs text-ink-500">
                <tr>
                  <th className="px-5 py-2.5 text-right font-medium">رقم الطلبية</th>
                  <th className="px-5 py-2.5 text-right font-medium">التاريخ</th>
                  <th className="px-5 py-2.5 text-right font-medium">المنتجات</th>
                  <th className="px-5 py-2.5 text-right font-medium">طلبيات علي</th>
                  <th className="px-5 py-2.5 text-right font-medium">الإجمالي</th>
                  <th className="px-5 py-2.5 text-right font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--color-border-app]">
                {recentOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-[--color-background]">
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
                      {formatDateAr(o.createdAt)}
                    </td>
                    <td className="px-5 py-3 nums">{o._count.items}</td>
                    <td className="px-5 py-3 nums">{o._count.aeOrders}</td>
                    <td className="px-5 py-3 font-medium nums">
                      {formatSar(Number(o.totalSar))}
                    </td>
                    <td className="px-5 py-3">
                      <OrderStatusBadge status={o.status} />
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
