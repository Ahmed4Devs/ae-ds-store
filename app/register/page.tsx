import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { AuthForm } from "@/components/auth-form";
import { Card } from "@/components/ui";
import { getCurrentUser } from "@/lib/session";

export const metadata = { title: "إنشاء حساب" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/account");

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="mb-1 text-xl font-bold">إنشاء حساب</h1>
          <p className="mb-6 text-sm text-ink-500">
            أنشئ حسابًا لحفظ عناوينك ومتابعة شحناتك.
          </p>
          <AuthForm mode="signup" />
          <p className="mt-5 text-center text-sm text-ink-500">
            لديك حساب بالفعل؟{" "}
            <Link href="/login" className="font-medium text-brand-600 hover:underline">
              تسجيل الدخول
            </Link>
          </p>
        </Card>
      </main>
      <SiteFooter />
    </>
  );
}
