/**
 * يفشل تشغيل نسخة الخادم قبل قبول أي طلب إذا كانت بيئة الإنتاج غير آمنة.
 * استدعاء env() داخل وحدات المسارات وحدها متأخر: قد تُخدَّم بعض الصفحات
 * الساكنة بينما أسرار المصادقة أو TLS مضبوطة خطأً.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { env } = await import("@/lib/env");
    env();
  }
}
