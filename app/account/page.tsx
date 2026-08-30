import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { SignOutButton } from "@/components/sign-out-button";
import { ButtonLink, Card } from "@/components/ui";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { formatSaudiPhone } from "@/lib/ksa";

export const metadata = { title: "حسابي" };

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [orderCount, addresses] = await Promise.all([
    prisma.order.count({ where: { userId: user.id } }),
    prisma.address.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const isAdmin = (user as { role?: string }).role === "ADMIN";

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">حسابي</h1>

        <Card className="mb-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-semibold">{user.name}</p>
              <p className="mt-0.5 text-sm text-ink-500" dir="ltr">
                {user.email}
              </p>
            </div>
            <SignOutButton />
          </div>
        </Card>

        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <Card className="p-5">
            <p className="text-sm text-ink-500">عدد الطلبات</p>
            <p className="mt-1 text-2xl font-bold nums">{orderCount}</p>
            <Link
              href="/orders"
              className="mt-2 inline-block text-sm text-brand-600 hover:underline"
            >
              عرض الطلبات
            </Link>
          </Card>

          <Card className="p-5">
            <p className="text-sm text-ink-500">العناوين المحفوظة</p>
            <p className="mt-1 text-2xl font-bold nums">{addresses.length}</p>
          </Card>
        </div>

        {addresses.length > 0 && (
          <Card className="mb-5 overflow-hidden">
            <p className="border-b border-[--color-border-app] px-5 py-3 font-semibold">
              عناويني
            </p>
            <ul className="divide-y divide-[--color-border-app]">
              {addresses.map((a) => (
                <li key={a.id} className="p-4 text-sm leading-relaxed">
                  <p className="font-medium">{a.fullName}</p>
                  <p className="text-ink-500" dir="ltr">
                    {formatSaudiPhone(a.phone)}
                  </p>
                  <p className="text-ink-500">
                    {a.addressLine1}، {a.city}، {a.province}
                  </p>
                  {a.nationalAddr && (
                    <p className="text-xs text-ink-500 nums">
                      العنوان الوطني: {a.nationalAddr}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {isAdmin && (
          <Card className="p-5">
            <p className="mb-1 font-semibold">لوحة الإدارة</p>
            <p className="mb-3 text-sm text-ink-500">
              متابعة الطلبيات وسجل استدعاءات الواجهات.
            </p>
            <ButtonLink href="/admin" variant="outline">
              فتح لوحة الإدارة
            </ButtonLink>
          </Card>
        )}
      </main>

      <SiteFooter />
    </>
  );
}
