import type { NextConfig } from "next";

/**
 * CSP الديناميكية ذات nonce تُنشأ في proxy.ts كي يمنح Next nonce لسكربتاته.
 * الترويسات الثابتة هنا لا تحمل أسرارًا ولا تتغير بين الطلبات.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  {
    key: "Permissions-Policy",
    value:
      "accelerometer=(), autoplay=(self), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(self), usb=()",
  },
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const NO_STORE_HEADERS = [
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
  { key: "Pragma", value: "no-cache" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  experimental: {
    // أعلى قليلًا من أكبر حد تطبيقي (512KB) كي يقرأ proxy البايت الزائد
    // ويرفض الطلب chunked؛ إن تساويا فقد يمر جسم مبتور بالحجم الحدّي.
    proxyClientMaxBodySize: "520kb",
    serverActions: {
      // لا توجد عمليات رفع ملفات؛ 256KB تشمل هامش multipart للنماذج النصية.
      bodySizeLimit: "256kb",
    },
    // سلامة حزم JS وقت البناء مع بقاء التوليد الساكن ممكنًا مستقبلًا.
    sri: { algorithm: "sha256" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // كل API في المشروع ديناميكي أو مرتبط بمستخدم/مزوّد خارجي.
      { source: "/api/:path*", headers: NO_STORE_HEADERS },
      {
        source: "/reset-password",
        headers: [
          ...NO_STORE_HEADERS,
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/two-factor",
        headers: [
          ...NO_STORE_HEADERS,
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
