import { timingSafeEqual } from "node:crypto";
import type { PaymentStatus } from "@/lib/generated/prisma/enums";

/**
 * عقد مزوّدي الدفع.
 *
 * الغرض من الفصل: منطق الطلبيات لا يعرف اسم المزوّد ولا شكل استجابته.
 * كل مزوّد يترجم واجهته الخاصة إلى هذين الشكلين فقط — نيّة دفع وحدث
 * إشعار — فيبقى التبديل بين مدى وTap والتأكيد اليدوي تغييرَ متغيّر بيئة
 * لا تغييرَ فروع داخل محرّك الطلبيات.
 */

export type PaymentProviderName = "manual" | "moyasar" | "tap";

export interface CreateIntentInput {
  orderId: string;
  orderNumber: string;
  /** المبلغ بالريال كما هو مخزَّن في الطلبية — لا يُعاد حسابه هنا */
  amountSar: number;
  customerEmail?: string;
  customerName?: string;
  /** الصفحة التي يعود إليها العميل بعد الدفع */
  returnUrl: string;
  /**
   * رقم المحاولة (1 للأولى). يدخل في بناء المرجع لأن `providerRef` فريد
   * على مستوى الجدول: بلا تمييز، محاولةٌ ثانية بعد انتهاء المهلة تصطدم
   * بمرجع المحاولة الأولى فيفشل بدء الدفع.
   */
  attempt: number;
  /**
   * مهلة النيّة عندنا. أغلب البوابات لا تقبل مهلة في طلب الإنشاء، لذا
   * نحرسها بأنفسنا في expireStaleIntents بدل الاعتماد على المزوّد.
   */
  expiresAt: Date;
}

export interface ProviderIntent {
  /** معرّف العملية لدى المزوّد — يجب أن يكون فريدًا لكل محاولة */
  providerRef: string;
  checkoutUrl: string | null;
  status: PaymentStatus;
}

export interface WebhookEvent {
  providerRef: string;
  status: PaymentStatus;
  failureCode?: string;
  failureMessage?: string;
  /**
   * المبلغ الذي أُخذ فعلًا لدى المزوّد، بالريال. تُقارنه التسوية بمبلغ
   * النيّة: خصمٌ جزئي أو حمولة معدَّلة لا يجوز أن يُسوّي طلبيةً بكاملها.
   * يُترك undefined حين لا يحمله الإشعار — والتسوية تتساهل حينها لأن
   * التوقيع تحقّق من الأصالة أصلًا.
   */
  amountSar?: number;
  currency?: string;
  payload: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  create(input: CreateIntentInput): Promise<ProviderIntent>;
  /**
   * يتحقق من صحة الإشعار ويترجمه. يعيد null عند فشل التحقق — والمسار
   * يترجم ذلك إلى 401 دون أي تفصيل، فلا يصير الردّ أوراكلًا يعلّم
   * المهاجم كيف يقترب من توقيع صحيح.
   */
  verifyWebhook(req: Request, rawBody: string): Promise<WebhookEvent | null>;
}

/** أسباب رفض إنشاء نيّة الدفع — تُترجَم في طبقة الإجراءات لا هنا. */
export type PaymentErrorCode =
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_PAYABLE"
  | "ALREADY_PAID"
  | "PROVIDER_FAILED";

/**
 * خطأ مصنَّف بدل نصّ خام: طبقة الإجراءات تترجمه إلى رسالة من القاموس،
 * فلا تتسرّب رموز المزوّد ولا نصوص أخطائه إلى المتصفّح.
 */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PaymentError";
    this.code = code;
  }
}

/**
 * مقارنة بزمن ثابت للتواقيع والأسرار.
 *
 * تعيش هنا لا في index.ts لأن ملفات المزوّدين تستوردها، وindex.ts يستورد
 * المزوّدين — فوضعُها هناك يصنع حلقة استيراد. وحراسة الطول قبل النداء
 * ضرورية: timingSafeEqual يرمي استثناءً عند اختلاف الأطوال بدل أن يعيد
 * false، فيتحوّل توقيع مشوّه إلى خطأ 500 يكشف نفسه.
 */
export function secretMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
