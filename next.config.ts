import type { NextConfig } from "next";

/**
 * سياسة أمان المحتوى.
 *
 * تسمح بالصور من مصادر https (صور منتجات AliExpress) والأنماط المضمّنة
 * (Tailwind وسكربت المظهر المضمّن في <head>). script-src يقبل 'unsafe-inline'
 * لأن سكربت المظهر يُحقن مضمّنًا؛ التحسين اللاحق استبداله بـ nonce.
 * frame-ancestors 'none' يمنع تضمين الصفحة في إطار (حماية من النقر المخفي).
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "font-src 'self' https: data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  // لا نفصح عن إطار العمل في ترويسة X-Powered-By
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
