import type { MetadataRoute } from "next";
import { POLICY_SLUGS } from "@/app/policies/[slug]/page";
import { env } from "@/lib/env";

/**
 * خريطة الموقع — الصفحات الثابتة فقط.
 *
 * لا نُعدّد المنتجات عمدًا: الكتالوج تمرير حيّ إلى AliExpress بلا مجموعة
 * روابط محلّية مستقرّة، فكل خريطة ستكون لقطة لعشرات الآلاف من الروابط
 * المولّدة من استدعاء واجهة عند كل طلب للخريطة — تحميل زائد على المورّد،
 * وروابط تتعفّن قبل أن تُزار. حين تظهر صفحات مجموعات ثابتة تُضاف هنا.
 *
 * كذلك لا تُدرَج المسارات الخاصّة (الحساب، السلة، الدفع، الطلبات) — وهي
 * الممنوعة نفسها في app/robots.ts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env().STORE_PUBLIC_URL.replace(/\/$/, "");
  const lastModified = new Date();

  return [
    { url: `${base}/`, lastModified, changeFrequency: "daily", priority: 1 },
    { url: `${base}/search`, lastModified, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/collection`, lastModified, changeFrequency: "daily", priority: 0.8 },
    ...POLICY_SLUGS.map((slug) => ({
      url: `${base}/policies/${slug}`,
      lastModified,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];
}
