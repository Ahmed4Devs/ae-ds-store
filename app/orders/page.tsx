import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ButtonLink, Card, EmptyState } from "@/components/ui";
import { OrderStatusBadge } from "@/components/order-status";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { formatSar } from "@/lib/pricing";
import { formatDateAr } from "@/lib/ksa";

export const metadata = { title: "طلباتي" };

export default async function OrdersPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16">
          <EmptyState
            title="سجّل الدخول لعرض طلباتك"
            description="تحتاج إلى حساب لمتابعة حالة طلباتك وتتبّع شحناتك."
            action={<ButtonLink href="/login">تسجيل الدخول</ButtonLink>}
          />
        </main>
        <SiteFooter />
      </>
    );
  }

  const orders = await prisma.order.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: {
      items: { select: { titleSnapshot: true, imageSnapshot: true, quantity: true } },
      _count: { select: { items: true } },
    },
    take: 50,
  });

  if (orders.length === 0) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16">
          <EmptyState
            title="لا توجد طلبات بعد"
            description="ابدأ التسوّق وستظهر طلباتك هنا."
            action={<ButtonLink href="/search">تصفّح المنتجات</ButtonLink>}
          />
        </main>
        <SiteFooter />
      </>
    );
  }

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">طلباتي</h1>

        <div className="space-y-3">
          {orders.map((o) => (
            <Link key={o.id} href={`/orders/${o.orderNumber}`}>
              <Card className="p-4 transition hover:border-brand-400">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold nums" dir="ltr">
                      {o.orderNumber}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatDateAr(o.createdAt)}
                    </p>
                  </div>
                  <OrderStatusBadge status={o.status} />
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <div className="flex -space-x-2 space-x-reverse">
                    {o.items.slice(0, 4).map((it, i) => (
                      <span
                        key={i}
                        className="size-11 overflow-hidden rounded-lg border-2 border-[--color-surface] bg-ink-100 dark:bg-ink-800"
                      >
                        {it.imageSnapshot && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={it.imageSnapshot}
                            alt=""
                            className="size-full object-cover"
                          />
                        )}
                      </span>
                    ))}
                  </div>
                  <p className="text-sm text-ink-500 nums">
                    {o._count.items} منتج
                  </p>
                  <p className="mr-auto font-bold nums">{formatSar(Number(o.totalSar))}</p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
