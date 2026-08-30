import { createHmac } from "node:crypto";

/**
 * خوارزمية توقيع منصة AliExpress المفتوحة.
 *
 * المرجع: التوثيق الرسمي — «خوارزمية التوقيع» (المستند 836).
 * الخطوات كما ينص عليها حرفيًا:
 *   1. رتّب جميع مُعاملات الطلب تصاعديًا وفق ASCII لأسماء المُعاملات،
 *      باستثناء `sign` والمُعاملات من نوع byte[].
 *   2. اربط اسم المُعامل بقيمته دون فواصل.
 *   3. ضع اسم الواجهة في مقدمة السلسلة.
 *   4. رمّز بـ UTF-8 واحسب البصمة بـ HMAC-SHA256 باستخدام app_secret مفتاحًا.
 *   5. حوّل الناتج إلى نظام ست عشري بأحرف كبيرة.
 */

/** القيم التي لا تدخل في حساب التوقيع (فارغة أو غير معرّفة). */
function isSignable(value: unknown): value is string | number | boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  return typeof value === "number" || typeof value === "boolean";
}

/**
 * يبني السلسلة الأساسية التي ستُوقَّع.
 * مُصدَّرة لأغراض الاختبار والتشخيص عند مواجهة `IncompleteSignature`.
 */
export function buildSignBase(
  apiName: string,
  params: Record<string, unknown>,
): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && isSignable(params[k]))
    .sort(); // ترتيب ASCII — الترتيب الافتراضي في JavaScript

  let base = apiName;
  for (const key of keys) {
    base += key + String(params[key]);
  }
  return base;
}

/**
 * يحسب قيمة المُعامل `sign`.
 *
 * @param apiName اسم الواجهة، مثل `aliexpress.ds.product.get`
 *                أو المسار في واجهات الرموز مثل `/auth/token/create`
 * @param params  جميع المُعاملات (العامة والخاصة بالأعمال) عدا `sign`
 * @param appSecret المفتاح السري للتطبيق
 */
export function signRequest(
  apiName: string,
  params: Record<string, unknown>,
  appSecret: string,
): string {
  const base = buildSignBase(apiName, params);
  return createHmac("sha256", appSecret)
    .update(base, "utf8")
    .digest("hex")
    .toUpperCase();
}

/**
 * الطابع الزمني بصيغة بروتوكول GOP (مللي ثانية).
 * التوثيق يشترط ألا يتجاوز الفارق عن UTC مقدار 7200 ثانية.
 */
export function currentTimestamp(): string {
  return String(Date.now());
}
