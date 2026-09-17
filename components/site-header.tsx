import Link from "next/link";
import { cartCount } from "@/lib/cart";
import { getCurrentUser } from "@/lib/session";
import { env } from "@/lib/env";
import { fill, getDictionary, getLocale } from "@/lib/i18n";
import { getTheme } from "@/lib/theme";
import { getBannerDismissed } from "@/lib/banner";
import { LanguageSwitcher, ThemeToggle } from "@/components/preferences";
import { AnnouncementBar } from "@/components/announcement-bar";

export async function SiteHeader() {
  const [count, user, t, locale, theme, bannerDismissed] = await Promise.all([
    cartCount(),
    getCurrentUser(),
    getDictionary(),
    getLocale(),
    getTheme(),
    getBannerDismissed(),
  ]);
  const mode = env().AE_MODE;

  return (
    <>
      {mode === "mock" && !bannerDismissed && (
        <AnnouncementBar closeLabel={t.common.close}>
          {t.banner.mockMode}
        </AnnouncementBar>
      )}

      <header className="sticky top-0 z-40 border-b border-(--color-border-app) bg-(--color-background)/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4">
          <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2 text-lg font-bold">
            <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-white">
              {locale === "ar" ? "و" : "W"}
            </span>
            <span className="hidden sm:inline">{t.meta.siteName}</span>
          </Link>

          <form action="/search" className="min-w-0 flex-1">
            <div className="relative">
              <input
                name="q"
                type="search"
                placeholder={t.nav.search}
                aria-label={t.nav.searchLabel}
                className="h-11 w-full rounded-full border border-(--color-border-app) bg-(--color-surface) px-4 text-sm outline-none focus:border-brand-500 ltr:pr-12 rtl:pl-12"
              />
              <button
                type="submit"
                aria-label={t.nav.searchLabel}
                className="absolute inset-y-0 grid size-11 place-items-center rounded-full text-ink-500 hover:bg-ink-100 ltr:right-0 rtl:left-0 dark:hover:bg-ink-800"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </button>
            </div>
          </form>

          <nav className="flex shrink-0 items-center gap-1">
            <div className="hidden items-center gap-2 md:flex">
              <ThemeToggle
                current={theme}
                labels={{
                  light: t.common.light,
                  dark: t.common.dark,
                  system: t.common.system,
                  theme: t.common.theme,
                }}
              />
              <LanguageSwitcher current={locale} label={t.common.language} />
            </div>

            <Link
              href="/orders"
              className="hidden min-h-11 items-center rounded-lg px-3 py-2 text-sm hover:bg-ink-100 sm:inline-flex dark:hover:bg-ink-800"
            >
              {t.nav.myOrders}
            </Link>

            <Link
              href="/cart"
              className="relative inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              {t.nav.cart}
              {count > 0 && (
                <span className="nums absolute -top-0.5 grid min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-[11px] font-bold text-white ltr:right-0 rtl:left-0">
                  {count}
                </span>
              )}
            </Link>

            {user ? (
              <Link
                href="/account"
                className="inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium hover:bg-ink-100 dark:hover:bg-ink-800"
              >
                {t.nav.account}
              </Link>
            ) : (
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
              >
                {t.nav.login}
              </Link>
            )}
          </nav>
        </div>

        {/* التفضيلات على الشاشات الصغيرة */}
        <div className="flex items-center justify-center gap-2 border-t border-(--color-border-app) px-4 py-2 md:hidden">
          <ThemeToggle
            current={theme}
            labels={{
              light: t.common.light,
              dark: t.common.dark,
              system: t.common.system,
              theme: t.common.theme,
            }}
          />
          <LanguageSwitcher current={locale} label={t.common.language} />
        </div>
      </header>
    </>
  );
}

export async function SiteFooter() {
  const t = await getDictionary();

  return (
    <footer className="mt-auto border-t border-(--color-border-app) bg-(--color-surface)">
      <div className="mx-auto max-w-7xl px-4 py-10 text-sm">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <p className="mb-2 font-bold">{t.meta.siteName}</p>
            <p className="leading-relaxed text-ink-500">{t.footer.about}</p>
          </div>
          <div>
            <p className="mb-2 font-semibold">{t.footer.links}</p>
            <ul className="space-y-1.5 text-ink-500">
              <li>
                <Link href="/search" className="inline-flex min-h-11 items-center hover:text-brand-600">
                  {t.footer.shop}
                </Link>
              </li>
              <li>
                <Link href="/orders" className="inline-flex min-h-11 items-center hover:text-brand-600">
                  {t.footer.trackOrder}
                </Link>
              </li>
              {/* السياسات في التذييل لا في الرأس: تُقرأ مرّة عند الحاجة،
                  ووجودها ظاهرًا في كل صفحة شرط في متاجر التجزئة السعودية. */}
              <li>
                <Link href="/policies/shipping" className="inline-flex min-h-11 items-center hover:text-brand-600">
                  {t.footer.shippingPolicy}
                </Link>
              </li>
              <li>
                <Link href="/policies/returns" className="inline-flex min-h-11 items-center hover:text-brand-600">
                  {t.policies.returnsTitle}
                </Link>
              </li>
              <li>
                <Link href="/policies/privacy" className="inline-flex min-h-11 items-center hover:text-brand-600">
                  {t.policies.privacyTitle}
                </Link>
              </li>
              <li>
                <Link href="/policies/terms" className="inline-flex min-h-11 items-center hover:text-brand-600">
                  {t.policies.termsTitle}
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-2 font-semibold">{t.footer.noticeTitle}</p>
            <p className="leading-relaxed text-ink-500">{t.footer.noticeBody}</p>
          </div>
        </div>
        <p className="mt-8 border-t border-(--color-border-app) pt-5 text-xs text-ink-500">
          {fill(t.footer.rights, { year: new Date().getFullYear() })}
        </p>
      </div>
    </footer>
  );
}
