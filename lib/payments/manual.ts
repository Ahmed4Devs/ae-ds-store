import type {
  CreateIntentInput,
  PaymentProvider,
  ProviderIntent,
  WebhookEvent,
} from "./types";

/**
 * المزوّد اليدوي — التحويل البنكي والتأكيد الإداري.
 *
 * ليس بديلًا مؤقّتًا عن بوابة: التحويل البنكي وسيلة دفع مستعملة فعلًا في
 * السوق السعودي، والتأكيد الإداري هو ما يقابلها. والأهم أنه يسلك **المسار
 * نفسه** الذي تسلكه البوابة الحقيقية — نيّة دفع لها سجلّ وحالة ومهلة، ثم
 * تسوية عبر settleIntent — فلا يصير تشغيل البوابة لاحقًا إعادةَ كتابةٍ
 * لمنطق الطلبيات، بل تغييرَ متغيّر بيئة.
 */
export const manualProvider: PaymentProvider = {
  name: "manual",

  async create(input: CreateIntentInput): Promise<ProviderIntent> {
    return {
      // المرجع مقروء للعميل عمدًا: يكتبه في وصف التحويل البنكي، فيتمكّن
      // المسؤول من مطابقة الحوالة بالطلبية بلا مراسلة.
      providerRef: buildRef(input.orderNumber, input.attempt),
      // لا صفحة دفع خارجية — التعليمات تُعرض في متجرنا
      checkoutUrl: null,
      status: "REQUIRES_ACTION",
    };
  },

  /**
   * لا إشعارات للتحويل البنكي — لا طرف خارجي يُبلّغنا. التأكيد يأتي من
   * لوحة الإدارة عبر confirmManualPayment، لا من هذا المسار.
   */
  async verifyWebhook(): Promise<WebhookEvent | null> {
    return null;
  },
};

/**
 * مرجع فريد لكل محاولة.
 *
 * التمييز بالمحاولة ضروري لا تجميلي: `providerRef` فريد على مستوى الجدول،
 * فلو أعاد العميل المحاولة بعد انتهاء المهلة لَاصطدم الإدراج بالمرجع
 * القديم وفشل بدء الدفع من جديد.
 */
function buildRef(orderNumber: string, attempt: number): string {
  return `manual_${orderNumber}_${attempt}`;
}
