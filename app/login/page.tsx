import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { AuthForm } from "@/components/auth-form";
import { Card } from "@/components/ui";
import { getCurrentUser } from "@/lib/session";

export const metadata = { title: "تسجيل الدخول" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/account");

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="mb-1 text-xl font-bold">تسجيل الدخول</h1>
          <p className="mb-6 text-sm text-ink-500">
            ادخل إلى حسابك لمتابعة طلباتك.
          </p>
          <AuthForm mode="signin" />
          <p className="mt-5 text-center text-sm text-ink-500">
            ليس لديك حساب؟{" "}
            <Link href="/register" className="font-medium text-brand-600 hover:underline">
              أنشئ حسابًا
            </Link>
          </p>
        </Card>
      </main>
      <SiteFooter />
    </>
  );
}
