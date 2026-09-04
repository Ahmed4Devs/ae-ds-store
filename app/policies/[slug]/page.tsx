import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { Card } from "@/components/ui";
import { formatDayAr } from "@/lib/ksa";
import { fill, getDictionary, getLocale, type Dictionary } from "@/lib/i18n";

/**
 * صفحات السياسات الأربع من ملف واحد.
 *
 * النصوص كلها في القاموس بالفعل، فالصفحة مجرّد خريطة من المسار إلى مفاتيحه.
 * اخترنا خريطة معرّفة بنوع `keyof Dictionary["policies"]` بدل تفريعة switch
 * لأن المترجم يرفض عندئذٍ أي مفتاح غير موجود أو أُعيدت تسميته — الانحراف
 * بين وثيقة عربية وأخرى إنجليزية يصبح خطأ بناء لا صفحة ناقصة في الإنتاج.
 */

type PolicyKey = keyof Dictionary["policies"];

interface PolicyDoc {
  titleKey: PolicyKey;
  introKey: PolicyKey;
  sections: Array<{ titleKey: PolicyKey; bodyKey: PolicyKey }>;
}

export const POLICY_SLUGS = ["shipping", "returns", "privacy", "terms"] as const;

export type PolicySlug = (typeof POLICY_SLUGS)[number];

const POLICIES: Record<PolicySlug, PolicyDoc> = {
  shipping: {
    titleKey: "shippingTitle",
    introKey: "shippingIntro",
    sections: [
      { titleKey: "shippingP1Title", bodyKey: "shippingP1Body" },
      { titleKey: "shippingP2Title", bodyKey: "shippingP2Body" },
      { titleKey: "shippingP3Title", bodyKey: "shippingP3Body" },
      { titleKey: "shippingP4Title", bodyKey: "shippingP4Body" },
    ],
  },
  returns: {
    titleKey: "returnsTitle",
    introKey: "returnsIntro",
    sections: [
      { titleKey: "returnsP1Title", bodyKey: "returnsP1Body" },
      { titleKey: "returnsP2Title", bodyKey: "returnsP2Body" },
      { titleKey: "returnsP3Title", bodyKey: "returnsP3Body" },
      { titleKey: "returnsP4Title", bodyKey: "returnsP4Body" },
    ],
  },
  privacy: {
    titleKey: "privacyTitle",
    introKey: "privacyIntro",
    sections: [
      { titleKey: "privacyP1Title", bodyKey: "privacyP1Body" },
      { titleKey: "privacyP2Title", bodyKey: "privacyP2Body" },
      { titleKey: "privacyP3Title", bodyKey: "privacyP3Body" },
      { titleKey: "privacyP4Title", bodyKey: "privacyP4Body" },
    ],
  },
  terms: {
    titleKey: "termsTitle",
    introKey: "termsIntro",
    sections: [
      { titleKey: "termsP1Title", bodyKey: "termsP1Body" },
      { titleKey: "termsP2Title", bodyKey: "termsP2Body" },
      { titleKey: "termsP3Title", bodyKey: "termsP3Body" },
      { titleKey: "termsP4Title", bodyKey: "termsP4Body" },
    ],
  },
};

/**
 * تاريخ آخر مراجعة للوثائق — ثابت مكتوب يدويًا لا new Date().
 * التاريخ الحيّ يوحي بمراجعة لم تحدث، وهو ادّعاء قانوني لا تجميل.
 */
const LAST_UPDATED = new Date("2026-08-01T00:00:00.000Z");

function isPolicySlug(value: string): value is PolicySlug {
  return (POLICY_SLUGS as readonly string[]).includes(value);
}

export function generateStaticParams() {
  return POLICY_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata(props: PageProps<"/policies/[slug]">) {
  const { slug } = await props.params;
  const t = await getDictionary();
  if (!isPolicySlug(slug)) return { title: t.policies.title };
  return { title: t.policies[POLICIES[slug].titleKey] };
}

export default async function PolicyPage(props: PageProps<"/policies/[slug]">) {
  const { slug } = await props.params;
  if (!isPolicySlug(slug)) notFound();

  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);
  const doc = POLICIES[slug];
  const others = POLICY_SLUGS.filter((s) => s !== slug);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <nav className="mb-6 text-sm text-ink-500">
          <Link href="/" className="hover:text-brand-600">
            {t.common.backToStore}
          </Link>
        </nav>

        <h1 className="text-2xl font-bold sm:text-3xl">{t.policies[doc.titleKey]}</h1>

        <p className="nums mt-2 text-xs text-ink-500">
          {fill(t.policies.lastUpdated, { date: formatDayAr(LAST_UPDATED, locale) })}
        </p>

        <p className="mt-6 text-base leading-loose text-ink-600 dark:text-ink-300">
          {t.policies[doc.introKey]}
        </p>

        <div className="mt-10 space-y-8">
          {doc.sections.map((section) => (
            <section key={section.titleKey}>
              <h2 className="text-lg font-semibold">{t.policies[section.titleKey]}</h2>
              <p className="mt-2 leading-loose text-ink-600 dark:text-ink-300">
                {t.policies[section.bodyKey]}
              </p>
            </section>
          ))}
        </div>

        <Card className="mt-10 p-5">
          <h2 className="font-semibold">{t.policies.contactTitle}</h2>
          <p className="mt-2 text-sm leading-loose text-ink-600 dark:text-ink-300">
            {t.policies.contactBody}
          </p>
        </Card>

        <nav className="mt-10 border-t border-[--color-border-app] pt-6">
          <p className="mb-3 text-sm font-semibold">{t.policies.title}</p>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-500">
            {others.map((other) => (
              <li key={other}>
                <Link href={`/policies/${other}`} className="hover:text-brand-600">
                  {t.policies[POLICIES[other].titleKey]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>

      <SiteFooter />
    </>
  );
}
