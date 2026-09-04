import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ButtonLink, Card, EmptyState } from "@/components/ui";
import { OrderStatusBadge } from "@/components/order-status";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { formatSar } from "@/lib/pricing";
import { formatDateAr } from "@/lib/ksa";
import { fill, getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.orders.title };
}

export default async function OrdersPage() {
  const [user, t, locale] = await Promise.all([
    getCurrentUser(),
    getDictionary(),
    getLocale(),
  ]);

  if (!user) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16">
          <EmptyState
            title={t.orders.loginTitle}
            description={t.orders.loginBody}
            action={<ButtonLink href="/login">{t.orders.loginCta}</ButtonLink>}
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
            title={t.orders.emptyTitle}
            description={t.orders.emptyBody}
            action={<ButtonLink href="/search">{t.orders.emptyCta}</ButtonLink>}
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
        <h1 className="mb-6 text-2xl font-bold">{t.orders.title}</h1>

        <div className="space-y-3">
          {orders.map((o) => (
            <Link key={o.id} href={`/orders/${o.orderNumber}`}>
              <Card className="p-4 transition hover:border-brand-400">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="nums font-semibold" dir="ltr">
                      {o.orderNumber}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatDateAr(o.createdAt, locale)}
                    </p>
                  </div>
                  <OrderStatusBadge status={o.status} labels={t.orders.status} />
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <div className="flex gap-1">
                    {o.items.slice(0, 4).map((it, i) => (
                      <span
                        key={i}
                        className="size-11 overflow-hidden rounded-lg border border-(--color-border-app) bg-ink-100 dark:bg-ink-800"
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
                  <p className="nums text-sm text-ink-500">
                    {fill(t.orders.itemsCount, { n: o._count.items })}
                  </p>
                  <p className="nums ms-auto font-bold">
                    {formatSar(Number(o.totalSar), locale)}
                  </p>
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
