import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * قواعد الزحف.
 *
 * المنع هنا ليس إخفاءً بل حماية: /cart و/checkout و/pay مسارات ذات أثر
 * جانبي (تُنشئ سلالًا وطلبات دفع)، و/account و/orders و/admin خاصّة بحساب
 * الزائر، و/api واجهات لا معنى لفهرستها. زاحف يفتحها يولّد ضجيجًا في
 * البيانات وقد يُطلق عمليات لا يقصدها أحد.
 */
export default function robots(): MetadataRoute.Robots {
  const base = env().STORE_PUBLIC_URL.replace(/\/$/, "");

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/account", "/cart", "/checkout", "/pay", "/orders", "/api"],
    },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
