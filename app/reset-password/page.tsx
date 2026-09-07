import Link from "next/link";
import { cookies } from "next/headers";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { Alert, Card } from "@/components/ui";
import { getDictionary } from "@/lib/i18n";
import {
  RESET_TOKEN_COOKIE,
  isResetToken,
} from "@/lib/reset-password-security";

export async function generateMetadata() {
  const t = await getDictionary();
  return {
    title: t.auth.resetTitle,
    robots: { index: false, follow: false },
    referrer: "no-referrer" as const,
  };
}

export default async function ResetPasswordPage(
  props: PageProps<"/reset-password">,
) {
  const [sp, t, cookieStore] = await Promise.all([
    props.searchParams,
    getDictionary(),
    cookies(),
  ]);

  /**
   * proxy يحوّل ?token إلى كوكي HttpOnly ثم يعيد التوجيه إلى URL نظيف.
   * وجود token هنا يعني أن الطلب تجاوز proxy؛ نفشل مغلقًا ولا نمرره إلى RSC.
   */
  const rejected =
    sp.token !== undefined ||
    (typeof sp.error === "string" && sp.error !== "");
  const usable =
    !rejected && isResetToken(cookieStore.get(RESET_TOKEN_COOKIE)?.value);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="mb-1 text-xl font-bold">
            {usable ? t.auth.resetTitle : t.auth.resetInvalidTitle}
          </h1>
          <p className="mb-6 text-sm leading-relaxed text-ink-500">
            {usable ? t.auth.resetSubtitle : t.auth.resetInvalidBody}
          </p>

          {usable ? (
            <ResetPasswordForm labels={t.auth} />
          ) : (
            <div className="space-y-4">
              <Alert tone="warning">{t.auth.resetInvalidBody}</Alert>
              <Link
                href="/forgot-password"
                className="block text-center text-sm font-medium text-brand-600 hover:underline"
              >
                {t.auth.resetRequestNew}
              </Link>
            </div>
          )}
        </Card>
      </main>
      <SiteFooter />
    </>
  );
}
