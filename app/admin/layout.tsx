import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

const NAV = [
  { href: "/admin", label: "نظرة عامة" },
  { href: "/admin/orders", label: "الطلبيات" },
  { href: "/admin/api-log", label: "سجل الواجهات" },
] as const;

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await getCurrentUser();

  // حماية على مستوى التخطيط: كل صفحة تحته تمر من هنا
  if (!user) redirect("/login");
  if ((user as { role?: string }).role !== "ADMIN") redirect("/account");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[--color-border-app] bg-[--color-surface]">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link href="/admin" className="font-bold">
            لوحة الإدارة
          </Link>
          <nav className="flex gap-1 text-sm">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded-lg px-3 py-1.5 hover:bg-ink-100 dark:hover:bg-ink-800"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/"
            className="mr-auto text-sm text-ink-500 hover:text-brand-600"
          >
            ← المتجر
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
