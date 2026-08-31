import type { Metadata, Viewport } from "next";
import { Tajawal } from "next/font/google";
import "./globals.css";
import { bcp47, dirFor, getDictionary, getLocale } from "@/lib/i18n";
import { getTheme, THEME_SCRIPT } from "@/lib/theme";
import { Providers } from "@/components/providers";

// Tajawal لا يملك وزن 600، لذا نحمّل 700 و800 ونعيد ربط أوزان Tailwind
// في globals.css حتى تبقى ثلاث درجات متمايزة بدل انهيار semibold على bold.
const arabic = Tajawal({
  variable: "--font-arabic",
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "700", "800"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDictionary();
  const locale = await getLocale();

  return {
    title: {
      default: `${t.meta.siteName} — ${t.meta.tagline}`,
      template: `%s · ${t.meta.siteName}`,
    },
    description: t.meta.description,
    openGraph: {
      type: "website",
      locale: bcp47(locale).replace("-", "_"),
      siteName: t.meta.siteName,
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [locale, theme] = await Promise.all([getLocale(), getTheme()]);

  // عند اختيار "تلقائي" لا يعرف الخادم تفضيل النظام، فنبدأ بالفاتح
  // ويصحّحه سكربت الرأس قبل الرسم.
  const resolvedTheme = theme === "system" ? "light" : theme;

  return (
    <html
      lang={locale}
      dir={dirFor(locale)}
      data-theme={resolvedTheme}
      data-theme-choice={theme}
      className={`${arabic.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
