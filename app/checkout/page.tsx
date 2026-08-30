import { redirect } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { CheckoutForm } from "@/components/checkout-form";
import { Alert, Card } from "@/components/ui";
import { readCart } from "@/lib/cart";
import { buildCartSummary } from "@/lib/cart-service";
import { formatSar } from "@/lib/pricing";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";

export const metadata = { title: "إتمام الشراء" };

export default async function CheckoutPage() {
  const cart = await readCart();
  if (cart.length === 0) redirect("/cart");

  const summary = await buildCartSummary(cart);
  if (summary.hasIssues) redirect("/cart");

  const user = await getCurrentUser();
  const savedAddress = user
    ? await prisma.address.findFirst({
        where: { userId: user.id },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      })
    : null;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">إتمام الشراء</h1>

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-5">
            <CheckoutForm
              isLoggedIn={Boolean(user)}
              defaults={
                savedAddress
                  ? {
                      fullName: savedAddress.fullName,
                      phone: savedAddress.phone,
                      province: savedAddress.province,
                      city: savedAddress.city,
                      addressLine1: savedAddress.addressLine1,
                      addressLine2: savedAddress.addressLine2 ?? "",
                      postalCode: savedAddress.postalCode ?? "",
                      nationalAddress: savedAddress.nationalAddr ?? "",
                    }
                  : undefined
              }
            />
          </div>

          <div>
            <Card className="sticky top-20 p-5">
              <p className="mb-4 font-semibold">ملخّص الطلب</p>

              <ul className="mb-4 space-y-3 border-b border-[--color-border-app] pb-4">
                {summary.lines.map((l) => (
                  <li
                    key={`${l.aeProductId}|${l.skuAttr}`}
                    className="flex gap-3 text-sm"
                  >
                    <span className="size-12 shrink-0 overflow-hidden rounded bg-ink-100 dark:bg-ink-800">
                      {l.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={l.imageUrl} alt="" className="size-full object-cover" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-xs leading-relaxed">
                        {l.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-500 nums">
                        {l.variantLabel} × {l.quantity}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-medium nums">
                      {formatSar(l.linePriceSar)}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-500">المجموع الفرعي</dt>
                  <dd className="nums">{formatSar(summary.subtotalSar)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">الشحن</dt>
                  <dd className="nums">{formatSar(summary.shippingSar)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">ضريبة القيمة المضافة</dt>
                  <dd className="nums">{formatSar(summary.vatSar)}</dd>
                </div>
                <div className="flex justify-between border-t border-[--color-border-app] pt-3 text-base font-bold">
                  <dt>الإجمالي</dt>
                  <dd className="nums">{formatSar(summary.totalSar)}</dd>
                </div>
              </dl>

              {summary.maxDeliveryDays != null && (
                <p className="mt-4 text-xs leading-relaxed text-ink-500">
                  التوصيل المتوقّع حتى{" "}
                  <span className="font-semibold nums">{summary.maxDeliveryDays}</span>{" "}
                  يوم عمل.
                </p>
              )}
            </Card>
          </div>
        </div>

        <div className="mt-6">
          <Alert tone="info" title="بوابة الدفع">
            هذه نسخة تطويرية: لم تُدمج بوابة دفع سعودية بعد. عند الضغط على
            «تأكيد الطلب» تُنشأ الطلبية وتُسجَّل كمدفوعة مباشرةً لأغراض
            الاختبار. اربط مدى أو Tap أو Moyasar قبل الإطلاق.
          </Alert>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
