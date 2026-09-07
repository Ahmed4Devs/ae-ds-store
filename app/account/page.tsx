import Link from "next/link";
import { redirect } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-header";
import { SignOutButton } from "@/components/sign-out-button";
import { AddressManager } from "@/components/address-manager";
import { ChangePasswordForm } from "@/components/change-password-form";
import { ProfileForm } from "@/components/profile-form";
import { AdminTwoFactorPanel } from "@/components/admin-two-factor-panel";
import { ButtonLink, Card } from "@/components/ui";
import { getCurrentUser, isAdmin } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.account.title };
}

export default async function AccountPage() {
  const [user, t] = await Promise.all([getCurrentUser(), getDictionary()]);
  if (!user) redirect("/login");

  const isAdminRole = (user as { role?: string }).role === "ADMIN";
  const twoFactorEnabled =
    (user as { twoFactorEnabled?: boolean }).twoFactorEnabled === true;

  const [orderCount, addresses, hasAdminAccess] = await Promise.all([
    prisma.order.count({ where: { userId: user.id } }),
    // كل العناوين لا أول خمسة: هذه الآن شاشة إدارة، وقصّ القائمة يعني
    // عنوانًا لا يستطيع صاحبه حذفه ولا تعديله.
    prisma.address.findMany({
      where: { userId: user.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    }),
    isAdminRole ? isAdmin() : Promise.resolve(false),
  ]);

  const phone = (user as { phone?: string | null }).phone ?? "";

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">{t.account.title}</h1>

        <Card className="mb-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-semibold">{user.name}</p>
              <p className="mt-0.5 text-sm text-ink-500" dir="ltr">
                {user.email}
              </p>
            </div>
            <SignOutButton label={t.nav.logout} />
          </div>
        </Card>

        <Card className="mb-5 p-5">
          <ProfileForm
            defaultName={user.name}
            defaultPhone={phone}
            email={user.email}
            labels={{
              title: t.account.profileTitle,
              name: t.account.nameLabel,
              phone: t.account.phoneLabel,
              phoneHint: t.checkout.phoneHint,
              email: t.account.emailLabel,
              emailImmutable: t.account.emailImmutable,
              saved: t.account.profileSaved,
              failed: t.account.profileFailed,
              save: t.common.save,
              saving: t.common.saving,
              nameRequired: t.auth.nameRequired,
            }}
          />
        </Card>

        <Card className="mb-5 p-5">
          <ChangePasswordForm
            labels={{
              title: t.account.changePasswordTitle,
              currentPassword: t.account.currentPassword,
              newPassword: t.account.newPassword,
              confirmPassword: t.account.confirmPassword,
              cta: t.account.changePasswordCta,
              processing: t.auth.processing,
              changed: t.account.passwordChanged,
              wrong: t.account.passwordWrong,
              policy: t.auth.passwordPolicy,
              mismatch: t.auth.passwordsMismatch,
              revokeOthers: t.account.revokeOthers,
              unexpectedError: t.common.unexpectedError,
            }}
          />
        </Card>

        {isAdminRole && (
          <Card className="mb-5 p-5">
            <p className="mb-4 font-semibold">{t.account.twoFactorTitle}</p>
            <AdminTwoFactorPanel
              enabled={twoFactorEnabled}
              sessionVerified={hasAdminAccess}
              labels={t.account}
              processingLabel={t.auth.processing}
            />
          </Card>
        )}

        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <Card className="p-5">
            <p className="text-sm text-ink-500">{t.account.ordersCount}</p>
            <p className="mt-1 text-2xl font-bold nums">{orderCount}</p>
            <Link
              href="/orders"
              className="mt-2 inline-block text-sm text-brand-600 hover:underline"
            >
              {t.account.viewOrders}
            </Link>
          </Card>

          <Card className="p-5">
            <p className="text-sm text-ink-500">{t.account.savedAddresses}</p>
            <p className="mt-1 text-2xl font-bold nums">{addresses.length}</p>
          </Card>
        </div>

        <AddressManager
          addresses={addresses.map((a) => ({
            id: a.id,
            fullName: a.fullName,
            phone: a.phone,
            province: a.province,
            city: a.city,
            addressLine1: a.addressLine1,
            addressLine2: a.addressLine2,
            postalCode: a.postalCode,
            nationalAddr: a.nationalAddr,
            isDefault: a.isDefault,
          }))}
          labels={t.account}
          fieldLabels={t.checkout}
          common={t.common}
        />

        {hasAdminAccess && (
          <Card className="p-5">
            <p className="mb-1 font-semibold">{t.account.adminTitle}</p>
            <p className="mb-3 text-sm text-ink-500">
              {t.account.adminBody}
            </p>
            <ButtonLink href="/admin" variant="outline">
              {t.account.adminCta}
            </ButtonLink>
          </Card>
        )}
      </main>

      <SiteFooter />
    </>
  );
}
