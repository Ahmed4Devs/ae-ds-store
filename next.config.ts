import type { NextConfig } from "next";

/**
 * سياسة أمان المحتوى.
 *
 * تسمح بالصور من مصادر https (صور منتجات AliExpress) والأنماط المضمّنة
 * (Tailwind وسكربت المظهر المضمّن في <head>). script-src يقبل 'unsafe-inline'
 * لأن سكربت المظهر يُحقن مضمّنًا؛ التحسين اللاحق استبداله بـ nonce.
 * frame-ancestors 'none' يمنع تضمين الصفحة في إطار (حماية من النقر المخفي).
 */

/**
 * أصول بوابات الدفع.
 *
 * سبب وجودها هنا: السياسة أعلاه `default-src 'self'` بلا `frame-src`، فأي
 * بوابة دفع مستضافة تُحجب في المتصفّح **بصمت** — لا رسالة خطأ في الخادم ولا
 * في سجلّ التطبيق، فقط إطار فارغ أو طلب لا يصل. هذا أكثر أعطال الدمج
 * إرباكًا، فنفتح الأصل المطلوب صراحةً حسب المزوّد المضبوط لا لكل المزوّدين.
 *
 * تُقرأ القيمة من process.env مباشرةً لا من lib/env.ts: هذا الملف يُقيَّم في
 * سياق البناء قبل تهيئة وحدة البيئة، واستيرادها هنا يُفشل البناء.
 */
const PAYMENT_ORIGINS: Record<string, readonly string[]> = {
  manual: [],
  moyasar: ["https://api.moyasar.com", "https://cdn.moyasar.com"],
  tap: ["https://api.tap.company", "https://secure.gosell.io"],
};

/**
 * أصول **كل** المزوّدين مجتمعةً لا المضبوط وحده.
 *
 * هذا الملف يُقيَّم وقت `next build`، فتُخبز قيمة PAYMENT_PROVIDER الحينية
 * في ترويسات الإنتاج. لو بنينا الصورة بمزوّد ثم غيّرناه في بيئة التشغيل
 * (وهو ما يقبله env.ts) لَحجب المتصفّح البوابة الجديدة بصمت — نفس عطل
 * الحجب الصامت الذي عولج أصلًا. توسيع القائمة إلى كل المزوّدين يزيل
 * الاعتماد على وقت البناء؛ وكلّها بوابات موثوقة فالتوسعة مأمونة.
 */
const paymentOrigins = Array.from(
  new Set(Object.values(PAYMENT_ORIGINS).flat()),
);
const extra = paymentOrigins.length > 0 ? ` ${paymentOrigins.join(" ")}` : "";

const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${extra}`,
  "font-src 'self' https: data:",
  `connect-src 'self'${extra}`,
  // صفحة الدفع المستضافة تُفتح في إطار أو بتحويل كامل حسب المزوّد
  `frame-src 'self'${extra}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  // form-action يشمل المزوّد لأن بعض البوابات تستقبل الدفع بإرسال نموذج
  `form-action 'self'${extra}`,
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
