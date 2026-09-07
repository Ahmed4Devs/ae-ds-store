import { redirect } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { TwoFactorChallenge } from "@/components/two-factor-challenge";
import { Card } from "@/components/ui";
import { getDictionary } from "@/lib/i18n";
import { getCurrentUser } from "@/lib/session";

export async function generateMetadata() {
  const t = await getDictionary();
  return {
    title: t.auth.twoFactorTitle,
    robots: { index: false, follow: false },
  };
}

export default async function TwoFactorPage() {
  const [user, t] = await Promise.all([getCurrentUser(), getDictionary()]);
  if (user) redirect("/account");

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="mb-1 text-xl font-bold">{t.auth.twoFactorTitle}</h1>
          <p className="mb-6 text-sm text-ink-500">
            {t.auth.twoFactorSubtitle}
          </p>
          <TwoFactorChallenge labels={t.auth} />
        </Card>
      </main>
      <SiteFooter />
    </>
  );
}
