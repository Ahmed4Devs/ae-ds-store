import Link from "next/link";
import { cartCount } from "@/lib/cart";
import { getCurrentUser } from "@/lib/session";
import { env } from "@/lib/env";

export async function SiteHeader() {
  const [count, user] = await Promise.all([cartCount(), getCurrentUser()]);
  const mode = env().AE_MODE;

  return (
    <>
      {mode === "mock" && (
        <div className="bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-amber-950">
          وضع المحاكاة — البيانات وهمية ولا تُنشأ طلبيات حقيقية. غيّر
          <code className="mx-1 rounded bg-amber-600/25 px-1">AE_MODE=live</code>
          في ملف .env للتشغيل الفعلي.
        </div>
      )}

      <header className="sticky top-0 z-40 border-b border-[--color-border-app] bg-[--color-background]/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
          <Link href="/" className="flex items-center gap-2 font-bold text-lg">
            <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-white">
              و
            </span>
            <span className="hidden sm:inline">متجر الوصل</span>
          </Link>

          <form action="/search" className="flex-1 max-w-xl">
            <div className="relative">
              <input
                name="q"
                type="search"
                placeholder="ابحث عن منتج…"
                aria-label="البحث عن منتجات"
                className="h-10 w-full rounded-full border border-[--color-border-app] bg-[--color-surface] pr-4 pl-11 text-sm outline-none focus:border-brand-500"
              />
              <button
                type="submit"
                aria-label="بحث"
                className="absolute left-1 top-1 grid size-8 place-items-center rounded-full text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </button>
            </div>
          </form>

          <nav className="flex items-center gap-1">
            <Link
              href="/orders"
              className="rounded-lg px-3 py-2 text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              طلباتي
            </Link>

            <Link
              href="/cart"
              className="relative rounded-lg px-3 py-2 text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              السلة
              {count > 0 && (
                <span className="absolute -top-0.5 left-0 grid min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-[11px] font-bold text-white nums">
                  {count}
                </span>
              )}
            </Link>

            {user ? (
              <Link
                href="/account"
                className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-ink-100 dark:hover:bg-ink-800"
              >
                حسابي
              </Link>
            ) : (
              <Link
                href="/login"
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
              >
                دخول
              </Link>
            )}
          </nav>
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-[--color-border-app] bg-[--color-surface]">
      <div className="mx-auto max-w-7xl px-4 py-10 text-sm">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <p className="mb-2 font-bold">متجر الوصل</p>
            <p className="text-ink-500 leading-relaxed">
              منتجات عالمية تصل إلى جميع مناطق المملكة. الأسعار بالريال السعودي
              شاملة ضريبة القيمة المضافة.
            </p>
          </div>
          <div>
            <p className="mb-2 font-semibold">روابط</p>
            <ul className="space-y-1.5 text-ink-500">
              <li><Link href="/search" className="hover:text-brand-600">تسوّق</Link></li>
              <li><Link href="/orders" className="hover:text-brand-600">تتبّع طلبك</Link></li>
              <li><Link href="/shipping-policy" className="hover:text-brand-600">سياسة الشحن</Link></li>
            </ul>
          </div>
          <div>
            <p className="mb-2 font-semibold">ملاحظة مهمة</p>
            <p className="text-ink-500 leading-relaxed">
              مدة التوصيل تتراوح بين أسبوع وستة أسابيع حسب خيار الشحن المختار،
              وتُعرض بوضوح قبل إتمام الطلب.
            </p>
          </div>
        </div>
        <p className="mt-8 border-t border-[--color-border-app] pt-5 text-xs text-ink-500">
          © {new Date().getFullYear()} متجر الوصل — جميع الحقوق محفوظة.
        </p>
      </div>
    </footer>
  );
}
