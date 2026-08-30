import { SiteHeader, SiteFooter } from "@/components/site-header";
import { CartLines } from "@/components/cart-lines";
import { Alert, ButtonLink, Card, EmptyState } from "@/components/ui";
import { readCart } from "@/lib/cart";
import { buildCartSummary } from "@/lib/cart-service";
import { formatSar } from "@/lib/pricing";

export const metadata = { title: "سلة التسوّق" };

export default async function CartPage() {
  const cart = await readCart();

  if (cart.length === 0) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16">
          <EmptyState
            title="سلتك فارغة"
            description="تصفّح المنتجات وأضف ما يعجبك."
            action={<ButtonLink href="/search">تصفّح المنتجات</ButtonLink>}
          />
        </main>
        <SiteFooter />
      </>
    );
  }

  const summary = await buildCartSummary(cart);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">سلة التسوّق</h1>

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            {summary.hasIssues && (
              <Alert tone="warning" title="بعض المنتجات تحتاج انتباهك">
                الأسعار والمخزون يُعاد التحقق منهما من المصدر عند فتح السلة،
                لذا قد تتغيّر بعد الإضافة. عدّل الأسطر المعلَّمة قبل المتابعة.
              </Alert>
            )}

            {summary.hasUntracked && (
              <Alert tone="info" title="شحنة بدون تتبع">
                اخترتَ طريقة شحن لا توفّر رقم تتبع. لن نتمكّن من إظهار مسار
                الشحنة لهذه المنتجات.
              </Alert>
            )}

            <CartLines lines={summary.lines} />
          </div>

          {/* الملخّص */}
          <div>
            <Card className="sticky top-20 p-5">
              <p className="mb-4 font-semibold">ملخّص الطلب</p>

              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-500">المجموع الفرعي</dt>
                  <dd className="nums">{formatSar(summary.subtotalSar)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">الشحن</dt>
                  <dd className="nums">{formatSar(summary.shippingSar)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">ضريبة القيمة المضافة (15%)</dt>
                  <dd className="nums">{formatSar(summary.vatSar)}</dd>
                </div>
                <div className="flex justify-between border-t border-[--color-border-app] pt-3 text-base font-bold">
                  <dt>الإجمالي</dt>
                  <dd className="nums">{formatSar(summary.totalSar)}</dd>
                </div>
              </dl>

              {summary.maxDeliveryDays != null && (
                <p className="mt-4 rounded-lg bg-[--color-background] p-3 text-xs leading-relaxed text-ink-500">
                  مدة التوصيل المتوقعة حتى{" "}
                  <span className="font-semibold nums">
                    {summary.maxDeliveryDays}
                  </span>{" "}
                  يوم عمل من تاريخ الطلب.
                </p>
              )}

              <ButtonLink
                href="/checkout"
                size="lg"
                className="mt-5 w-full"
                aria-disabled={summary.hasIssues}
              >
                متابعة الشراء
              </ButtonLink>

              {summary.hasIssues && (
                <p className="mt-2 text-center text-xs text-amber-700 dark:text-amber-400">
                  عالج التنبيهات أولًا
                </p>
              )}
            </Card>
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
