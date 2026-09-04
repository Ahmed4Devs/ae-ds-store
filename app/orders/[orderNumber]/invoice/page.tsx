import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { ButtonLink, EmptyState } from "@/components/ui";
import { InvoiceView, type InvoiceLine } from "@/components/invoice-view";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/session";
import { ownsGuestOrder } from "@/lib/guest-orders";
import { buildZatcaTlv, zatcaQrDataUrl } from "@/lib/zatca";
import type { ShippingAddress } from "@/lib/ksa";
import { getDictionary, getLocale } from "@/lib/i18n";
import type { OrderStatus } from "@/lib/generated/prisma/client";

/**
 * الفاتورة الضريبية المبسّطة لطلبية واحدة.
 *
 * المكوّن خادمي لأن رمز ZATCA يُبنى بـ Buffer ويُرسم بحزمة `qrcode` —
 * كلاهما خادمي، وتمريرهما إلى المتصفّح يعني تسريب منطق الفوترة وبيانات
 * المنشأة إلى حزمة العميل بلا فائدة.
 */

/**
 * الحالات التي تصحّ معها فاتورة.
 *
 * الفاتورة إقرار بتحصيل ضريبة، فلا تُصدَر قبل تأكيد الدفع (PENDING_PAYMENT)
 * ولا بعد الإلغاء (CANCELLED) — وطباعة ورقة تحمل ضريبة لم تُحصَّل أو رُدَّت
 * تخلق فرقًا في الإقرار الضريبي يصعب تفسيره لاحقًا.
 */
const INVOICEABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "PAID",
  "SOURCING",
  "SOURCED",
  "SOURCING_FAILED",
  "SHIPPED",
  "DELIVERED",
]);

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.invoice.title };
}

export default async function OrderInvoicePage(
  props: PageProps<"/orders/[orderNumber]/invoice">,
) {
  const { orderNumber } = await props.params;

  const [user, t, locale] = await Promise.all([
    getCurrentUser(),
    getDictionary(),
    getLocale(),
  ]);

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      // أحدث نيّة مدفوعة — منها لحظة الدفع (نقطة الضريبة) الثابتة
      payments: {
        where: { status: "PAID" },
        orderBy: { paidAt: "desc" },
        take: 1,
        select: { paidAt: true },
      },
    },
  });

  if (!order) notFound();

  // نفس حارس صفحة الطلبية حرفيًا: صاحب الحساب، أو المتصفّح الذي أنشأ
  // طلبية الضيف. والرفض 404 لا 403 حتى لا تتحوّل الاستجابة إلى عرّاف
  // يؤكّد وجود رقم طلبية لمن يخمّن الأرقام.
  if (order.userId) {
    if (order.userId !== user?.id) notFound();
  } else if (!(await ownsGuestOrder(orderNumber))) {
    notFound();
  }

  if (!INVOICEABLE.has(order.status)) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
          <EmptyState
            title={t.invoice.notAvailableTitle}
            description={t.invoice.notAvailableBody}
            action={
              <ButtonLink href={`/orders/${orderNumber}`} variant="outline" size="sm">
                {t.orders.detailTitle}
              </ButtonLink>
            }
          />
        </main>
        <SiteFooter />
      </>
    );
  }

  const cfg = env();
  const addr = order.shippingSnapshot as unknown as ShippingAddress;

  // المبالغ Decimal في قاعدة البيانات — بلا Number() تصير المقارنة والجمع
  // على كائنات لا على أرقام.
  const subtotalSar = Number(order.subtotalSar);
  const shippingSar = Number(order.shippingSar);
  const vatSar = Number(order.vatSar);
  const totalSar = Number(order.totalSar);

  // تاريخ الإصدار = لحظة الدفع (نقطة الضريبة)، وهي **ثابتة**: تُؤخذ من
  // paidAt للنيّة المدفوعة أولًا. الاعتماد على placedAt كان يجعل الرقم
  // يتغيّر بين طباعتين (يُضبط placedAt وقت التوريد لا الدفع)، والرجوع إلى
  // createdAt كان يختم لحظة الإنشاء (قبل الدفع). الترتيب: الدفع، ثم
  // التوريد، ثم الإنشاء كملاذ أخير للطلبيات القديمة.
  const issuedAt = order.payments[0]?.paidAt ?? order.placedAt ?? order.createdAt;

  /**
   * الرقم الضريبي الفارغ يُلغي الرمز كلّه لا يُفرّغ حقلًا فيه: رمز يمسحه
   * المشتري ويجده بلا رقم ضريبي أسوأ من غياب الرمز، لأنه يوهم بامتثال
   * غير قائم.
   */
  const qrDataUrl = cfg.STORE_VAT_NUMBER
    ? await zatcaQrDataUrl(
        buildZatcaTlv({
          sellerName: cfg.STORE_LEGAL_NAME,
          vatNumber: cfg.STORE_VAT_NUMBER,
          issuedAt,
          totalWithVat: totalSar,
          vatTotal: vatSar,
        }),
      )
    : null;

  const lines: InvoiceLine[] = order.items.map((it) => ({
    id: it.id,
    title: it.titleSnapshot,
    variantLabel: it.variantLabel,
    quantity: it.quantity,
    unitPriceSar: Number(it.unitPriceSar),
  }));

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <InvoiceView
          locale={locale}
          labels={t.invoice}
          invoiceNumber={order.orderNumber}
          issuedAtIso={issuedAt.toISOString()}
          sellerName={cfg.STORE_LEGAL_NAME}
          vatNumber={cfg.STORE_VAT_NUMBER}
          crNumber={cfg.STORE_CR_NUMBER}
          buyerName={addr.fullName ?? null}
          address={addr}
          lines={lines}
          subtotalSar={subtotalSar}
          shippingSar={shippingSar}
          vatSar={vatSar}
          totalSar={totalSar}
          vatPercent={cfg.VAT_PERCENT}
          qrDataUrl={qrDataUrl}
        />
      </main>

      <SiteFooter />
    </>
  );
}
