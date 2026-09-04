import { SiteFooter, SiteHeader } from "@/components/site-header";
import { ErrorView } from "@/components/error-view";
import { getDictionary } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.errorPage.notFoundTitle };
}

/**
 * صفحة 404 — مكوّن خادم، بخلاف حدود الخطأ، فتقرأ لغة الزائر من الكوكي
 * وتعرض قشرة المتجر كاملة. المقصود ألّا يشعر الزائر أنه غادر المتجر:
 * الرابط الخطأ يقود إلى البحث لا إلى طريق مسدود.
 */
export default async function NotFound() {
  const t = await getDictionary();

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <ErrorView
          title={t.errorPage.notFoundTitle}
          body={t.errorPage.notFoundBody}
          secondary={{ href: "/search", label: t.errorPage.searchCta }}
          homeLabel={t.common.goHome}
        />
      </main>

      <SiteFooter />
    </>
  );
}
