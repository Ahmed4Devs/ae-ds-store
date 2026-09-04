import { notFound } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { Alert, ButtonLink, Card } from "@/components/ui";
import { PaymentPanel } from "@/components/payment-panel";
import { prisma } from "@/lib/db";
import { ownsGuestOrder } from "@/lib/guest-orders";
import { activeProvider, getLatestIntent } from "@/lib/payments";
import { formatSar } from "@/lib/pricing";
import { getCurrentUser } from "@/lib/session";
import { getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.payment.title };
}

/** أسماء المزوّدين المعروضة — القاموس لا يقبل فهرسة حرّة. */
function providerLabel(
  provider: ReturnType<typeof activeProvider>,
  t: Awaited<ReturnType<typeof getDictionary>>,
): string {
  if (provider === "moyasar") return t.payment.providerMoyasar;
  if (provider === "tap") return t.payment.providerTap;
  return t.payment.providerManual;
}

export default async function PayPage(props: PageProps<"/pay/[orderNumber]">) {
  const { orderNumber } = await props.params;

  const [user, t, locale] = await Promise.all([
    getCurrentUser(),
    getDictionary(),
    getLocale(),
  ]);

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: {
      id: true,
      orderNumber: true,
      userId: true,
      status: true,
      totalSar: true,
    },
  });

  if (!order) notFound();

  // الملكية نفسها المطبَّقة في صفحة الطلب: طلبية الحساب لصاحبها، وطلبية
  // الضيف للمتصفّح الذي أنشأها. و404 لا 403 حتى لا يصير الردّ أوراكلًا.
  if (order.userId) {
    if (order.userId !== user?.id) notFound();
  } else if (!(await ownsGuestOrder(orderNumber))) {
    notFound();
  }

  const intent = await getLatestIntent(order.id);
  const provider = activeProvider();
  const orderHref = `/orders/${order.orderNumber}`;

  // ------------------------------------------------ حالات لا تقبل دفعًا
  const settled =
    order.status === "PAID" ||
    order.status === "SOURCING" ||
    order.status === "SOURCED" ||
    order.status === "SHIPPED" ||
    order.status === "DELIVERED";

  const shell = (children: React.ReactNode) => (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        {children}
      </main>
      <SiteFooter />
    </>
  );

  if (order.status === "CANCELLED") {
    return shell(
      <>
        <h1 className="mb-6 text-2xl font-bold">{t.payment.title}</h1>
        <Alert tone="warning" title={t.orders.cancelledTitle}>
          <p>{t.orders.cancelledBody}</p>
        </Alert>
        <div className="mt-5">
          <ButtonLink href={orderHref} variant="outline">
            {t.orders.detailTitle}
          </ButtonLink>
        </div>
      </>,
    );
  }

  if (settled) {
    return shell(
      <>
        <h1 className="mb-6 text-2xl font-bold">{t.payment.title}</h1>
        <Alert tone="success" title={t.payment.statusPaidTitle}>
          <p>{t.payment.statusPaidBody}</p>
        </Alert>
        <div className="mt-5">
          <ButtonLink href={orderHref}>{t.orders.detailTitle}</ButtonLink>
        </div>
      </>,
    );
  }

  // -------------------------------------------------- حالة النيّة القائمة
  const expired =
    intent?.status === "EXPIRED" ||
    (intent != null &&
      intent.expiresAt != null &&
      intent.expiresAt <= new Date() &&
      intent.status !== "PAID");

  const failed = intent?.status === "FAILED";
  const awaiting = intent?.status === "PENDING";
  const canRetry = Boolean(expired || failed);

  return shell(
    <>
      <h1 className="mb-2 text-2xl font-bold">{t.payment.title}</h1>
      <p className="nums mb-6 text-sm text-ink-500" dir="ltr">
        {order.orderNumber}
      </p>

      <Card className="mb-6 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-sm text-ink-500">{t.payment.amountDue}</span>
          <span className="nums text-2xl font-bold">
            {formatSar(Number(order.totalSar), locale)}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3 border-t border-[--color-border-app] pt-3">
          <span className="text-sm text-ink-500">{t.payment.provider}</span>
          <span className="text-sm font-medium">
            {providerLabel(provider, t)}
          </span>
        </div>
      </Card>

      {awaiting && (
        <div className="mb-5">
          <Alert tone="info" title={t.payment.statusAwaitingTitle}>
            <p>{t.payment.statusAwaitingBody}</p>
          </Alert>
        </div>
      )}

      {failed && (
        <div className="mb-5">
          <Alert tone="danger" title={t.payment.statusFailedTitle}>
            <p>{t.payment.statusFailedBody}</p>
          </Alert>
        </div>
      )}

      {expired && !failed && (
        <div className="mb-5">
          <Alert tone="warning" title={t.payment.statusExpiredTitle}>
            <p>{t.payment.statusExpiredBody}</p>
          </Alert>
        </div>
      )}

      <PaymentPanel
        orderNumber={order.orderNumber}
        isManual={provider === "manual"}
        providerRef={canRetry ? null : (intent?.providerRef ?? null)}
        checkoutUrl={canRetry ? null : (intent?.checkoutUrl ?? null)}
        canRetry={canRetry}
        labels={{
          payNow: t.payment.payNow,
          processing: t.payment.processing,
          redirecting: t.payment.redirecting,
          continueToProvider: t.payment.continueToProvider,
          manualTitle: t.payment.manualTitle,
          manualBody: t.payment.manualBody,
          manualReferenceNote: t.payment.manualReferenceNote,
          reference: t.payment.reference,
          createFailed: t.payment.createFailed,
          retry: t.payment.retry,
        }}
      />

      <div className="mt-8">
        <ButtonLink href={orderHref} variant="ghost" size="sm">
          {t.orders.detailTitle}
        </ButtonLink>
      </div>
    </>,
  );
}
