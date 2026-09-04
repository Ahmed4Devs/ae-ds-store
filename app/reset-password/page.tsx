import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { Alert, Card } from "@/components/ui";
import { getDictionary } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.auth.resetTitle };
}

export default async function ResetPasswordPage(
  props: PageProps<"/reset-password">,
) {
  const [sp, t] = await Promise.all([props.searchParams, getDictionary()]);

  const token = typeof sp.token === "string" ? sp.token : "";
  /**
   * تعيد better-auth المستخدم إلى هنا بأحد شكلين: `?token=…` عند صحّة
   * الرمز، أو `?error=INVALID_TOKEN` عند انتهائه أو استهلاكه — فنتعامل
   * مع الحالتين، ومع غياب المُعاملين معًا (من فتح الصفحة مباشرةً).
   */
  const rejected = typeof sp.error === "string" && sp.error !== "";
  const usable = token !== "" && !rejected;

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
            <ResetPasswordForm token={token} labels={t.auth} />
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
