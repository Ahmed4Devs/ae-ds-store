import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { Card } from "@/components/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.auth.forgotTitle };
}

export default async function ForgotPasswordPage() {
  const [user, t] = await Promise.all([getCurrentUser(), getDictionary()]);
  // من دخل حسابه لا يحتاج استعادة — يغيّر كلمته من صفحة الحساب
  if (user) redirect("/account");

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="mb-1 text-xl font-bold">{t.auth.forgotTitle}</h1>
          <p className="mb-6 text-sm leading-relaxed text-ink-500">
            {t.auth.forgotSubtitle}
          </p>

          <ForgotPasswordForm labels={t.auth} />

          <p className="mt-5 text-center text-sm text-ink-500">
            <Link
              href="/login"
              className="font-medium text-brand-600 hover:underline"
            >
              {t.auth.signIn}
            </Link>
          </p>
        </Card>
      </main>
      <SiteFooter />
    </>
  );
}
