/**
 * تصنيف أخطاء واجهات AliExpress.
 *
 * الفكرة المحورية: التوثيق يفرّق ضمنيًا بين أخطاء تستحق إعادة المحاولة
 * وأخرى تعني «توقّف وتدخّل يدويًا». خلطهما في منطق واحد يُغرق النظام
 * بمحاولات فاشلة ويضاعف الطلبيات.
 *
 * المصدر: أقسام «رموز الأخطاء» في صفحات فئة AE-Dropshipper.
 */

export type ErrorClass =
  /** يمكن إعادة المحاولة كما هي بعد مهلة قصيرة */
  | "RETRYABLE"
  /** أعد جلب البيانات (سعر/مخزون/خط شحن) ثم أعد المحاولة */
  | "REFRESH_THEN_RETRY"
  /** خطأ في مدخلات العميل — أصلح البيانات ولا تُعد المحاولة آليًا */
  | "INVALID_INPUT"
  /** مشكلة في التفويض — جدّد الرمز أو أعد التفويض */
  | "AUTH"
  /** توقّف نهائيًا — يتطلب تدخّلًا بشريًا أو دعمًا فنيًا */
  | "FATAL"
  /** الطلبية أُنشئت مسبقًا — ابحث عنها بـ out_order_id ولا تُعد الإنشاء */
  | "DUPLICATE";

interface ErrorRule {
  class: ErrorClass;
  /** رسالة عربية تُعرض للمشغّل في لوحة التحكم */
  operatorMessage: string;
  /** رسالة عربية آمنة تُعرض للعميل النهائي */
  customerMessage?: string;
}

/**
 * خريطة رموز الأخطاء الموثّقة.
 * الرموز مأخوذة حرفيًا من صفحات الواجهات في التوثيق الرسمي.
 */
const ERROR_RULES: Record<string, ErrorRule> = {
  INVALID_LOCAL_INPUT: {
    class: "INVALID_INPUT",
    operatorMessage: "رفض التطبيق مدخلًا غير صالح قبل إرساله إلى المنصة.",
    customerMessage: "تعذّر التحقق من بيانات الطلب بأمان.",
  },
  // --- ds.order.create ---
  REPEATED_ORDER_ERROR: {
    class: "DUPLICATE",
    operatorMessage:
      "طلبية مكرّرة. ابحث عن الطلبية بـ out_order_id بدل إعادة الإنشاء.",
  },
  INVENTORY_HOLD_ERROR: {
    class: "REFRESH_THEN_RETRY",
    operatorMessage: "المخزون غير كافٍ أو حدث خطأ في النظام. أعد التحقق من المخزون.",
    customerMessage: "نفدت كمية أحد المنتجات. سنتواصل معك بشأن هذا الطلب.",
  },
  DELIVERY_METHOD_NOT_EXIST: {
    class: "REFRESH_THEN_RETRY",
    operatorMessage:
      "رمز خدمة الشحن غير صالح. أعد استدعاء ds.freight.query وخذ code منه.",
  },
  PRICE_PAY_CURRENCY_ERROR: {
    class: "INVALID_INPUT",
    operatorMessage: "تضارب في العملات. وحّد pay_currency مع عملة المنتجات.",
  },
  B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL: {
    class: "INVALID_INPUT",
    operatorMessage: "فشل التحقق من عنوان التسليم.",
    customerMessage: "تعذّر التحقق من عنوان الشحن. يُرجى مراجعة بياناته.",
  },
  B_DROPSHIPPER_DELIVERY_ADDRESS_CPF_CN_INVALID: {
    class: "INVALID_INPUT",
    operatorMessage: "رقم CPF غير صالح (خاص بالبرازيل).",
    customerMessage: "رقم التعريف الضريبي غير صالح.",
  },
  B_DROPSHIPPER_DELIVERY_ADDRESS_CPF_NOT_MATCH: {
    class: "INVALID_INPUT",
    operatorMessage: "رقم CPF غير مطابق للاسم.",
    customerMessage: "رقم التعريف الضريبي غير مطابق للاسم.",
  },
  BLACKLIST_BUYER_IN_LIST: {
    class: "FATAL",
    operatorMessage:
      "حساب المشتري مدرج في القائمة السوداء. تدخّل يدوي فوري مطلوب.",
  },
  USER_ACCOUNT_DISABLED: {
    class: "FATAL",
    operatorMessage: "حساب التشغيل معطّل. تدخّل يدوي فوري مطلوب.",
  },
  ERROR_WHEN_BUILD_FOR_PLACE_ORDER: {
    class: "FATAL",
    operatorMessage: "خطأ أثناء تجهيز الطلبية. التوثيق ينص على التواصل مع الدعم الفني.",
  },
  INVALID_ORDER_CREATE_RESPONSE: {
    class: "FATAL",
    operatorMessage:
      "أعلنت المنصة نجاح الإنشاء دون معرّفات فريدة قابلة للمطابقة. لا تُعد المحاولة قبل التحقق اليدوي.",
  },
  INVALID_UPSTREAM_FINANCIAL_DATA: {
    class: "FATAL",
    operatorMessage:
      "أعادت المنصة سعرًا أو عملة أو مخزونًا غير صالح. أوقف بيع المنتج حتى تتطابق البيانات.",
    customerMessage: "بيانات سعر هذا المنتج غير متاحة بأمان حاليًا.",
  },
  A001_ORDER_CANNOT_BE_PLACED: {
    class: "FATAL",
    operatorMessage: "تعذّر تقديم الطلبية — رفض من نظام المخاطر.",
  },
  A002_INVALID_ZONE: {
    class: "FATAL",
    operatorMessage: "المنطقة غير صالحة — رفض من نظام المخاطر.",
  },
  A003_SUSPICIOUS_BUYER: {
    class: "FATAL",
    operatorMessage: "مشترٍ مشبوه — رفض من نظام المخاطر.",
  },
  A004_CANNOT_USER_COUPON: {
    class: "FATAL",
    operatorMessage: "لا يمكن استخدام القسيمة.",
  },
  A005_INVALID_COUNTRIES: {
    class: "FATAL",
    operatorMessage: "دولة غير صالحة للشحن.",
  },
  A006_INVALID_ACCOUNT_INFO: {
    class: "FATAL",
    operatorMessage: "معلومات الحساب غير صالحة.",
  },

  // --- ds.product.get ---
  ITEM_ID_NOT_FOUND: {
    class: "INVALID_INPUT",
    operatorMessage: "معرّف المنتج غير موجود. علّمه غير متاح في الكتالوج.",
  },
  "Item is not allowed to this country": {
    class: "INVALID_INPUT",
    operatorMessage:
      "المنتج ممنوع في هذه الدولة. أخفِه من الكتالوج لهذه السوق.",
    customerMessage: "هذا المنتج غير متاح للشحن إلى بلدك.",
  },

  // --- ds.freight.query ---
  DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS: {
    class: "INVALID_INPUT",
    operatorMessage: "لا تتوفر خدمة توصيل إلى هذا العنوان.",
    customerMessage: "لا يتوفر شحن إلى هذا العنوان حاليًا.",
  },
  DELIVERY_INFO_EMPTY: {
    class: "INVALID_INPUT",
    operatorMessage: "معلومات التسليم فارغة — تحقّق من معرّف المنتج.",
  },

  // --- ds.order.tracking.get ---
  "TRACKING DATA NOT FOUND": {
    class: "RETRYABLE",
    operatorMessage:
      "لا توجد بيانات تتبع بعد. طبيعي قبل شحن البائع — عاملها كحالة «قيد التجهيز».",
  },
  UnsupportedParamMapping: {
    class: "INVALID_INPUT",
    operatorMessage: "تعيين المُعاملات غير مدعوم.",
  },

  // --- التفويض والنظام ---
  IllegalAccessToken: {
    class: "AUTH",
    operatorMessage: "رمز الوصول غير صالح. جدّده عبر /auth/token/refresh.",
  },
  "Illegal Refresh Token": {
    class: "AUTH",
    operatorMessage: "رمز التحديث غير صالح. أعد عملية التفويض من البداية.",
  },
  InvalidAppkey: {
    class: "AUTH",
    operatorMessage: "مفتاح التطبيق غير صالح.",
  },
  IncompleteSignature: {
    class: "FATAL",
    operatorMessage:
      "التوقيع لا يطابق مواصفات المنصة. راجع خوارزمية التوقيع (المستند 836).",
  },
  "Illegal timestap format": {
    class: "RETRYABLE",
    operatorMessage:
      "صيغة الطابع الزمني خاطئة أو الفارق عن UTC يتجاوز 7200 ثانية. زامن ساعة الخادم.",
  },
  AUTH_TYPE_UNSUPPORTED: {
    class: "AUTH",
    operatorMessage: "نوع التفويض غير مدعوم لهذه الواجهة.",
  },
  "isv.insufficient-permission": {
    class: "AUTH",
    operatorMessage: "صلاحيات التطبيق غير كافية لهذه الواجهة.",
  },
  "isv.invalid-authorization": {
    class: "AUTH",
    operatorMessage: "تفويض غير صالح — محاولة وصول إلى بيانات لا تخص الحساب.",
  },
  ServiceUnavailable: {
    class: "RETRYABLE",
    operatorMessage: "الخدمة غير متاحة مؤقتًا.",
  },
  "isp.service-unavailable": {
    class: "RETRYABLE",
    operatorMessage: "انتهت مهلة الخدمة لدى المزوّد.",
  },
  InternalError: {
    class: "RETRYABLE",
    operatorMessage: "خطأ داخلي لدى المنصة.",
  },
  "System Error": {
    class: "RETRYABLE",
    operatorMessage: "خطأ في النظام.",
  },
};

/**
 * Provider error identifiers are untrusted data, not log text. Preserve only
 * codes in the reviewed documentation map. An unknown value becomes one fixed
 * label so a compromised/reflected upstream cannot exfiltrate data through the
 * database, logs, or operator UI by placing it in `code`.
 */
export function normalizeAeErrorCode(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_.: -]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[_ ]+|[_ ]+$/g, "")
    .slice(0, 128);
  return Object.hasOwn(ERROR_RULES, normalized)
    ? normalized
    : "UNKNOWN_UPSTREAM_ERROR";
}

/** خطأ صادر عن واجهة AliExpress مع تصنيفه. */
export class AeApiError extends Error {
  readonly code: string;
  readonly errorClass: ErrorClass;
  readonly apiName: string;
  readonly operatorMessage: string;
  readonly customerMessage: string;

  constructor(opts: {
    apiName: string;
    code: string;
    message?: string;
  }) {
    const code = normalizeAeErrorCode(opts.code);
    const rule = Object.hasOwn(ERROR_RULES, code) ? ERROR_RULES[code] : undefined;
    const operatorMessage =
      rule?.operatorMessage ?? `خطأ غير مصنّف من المنصة (${code}).`;
    // `opts.message` is intentionally not propagated. It is provider-controlled
    // and may reflect credentials or customer data even after control stripping.
    super(operatorMessage);
    this.name = "AeApiError";
    this.apiName = opts.apiName;
    this.code = code;
    this.errorClass = rule?.class ?? "FATAL";
    this.operatorMessage = operatorMessage;
    this.customerMessage =
      rule?.customerMessage ??
      "تعذّر إتمام العملية حاليًا. يُرجى المحاولة لاحقًا.";
  }

  /** هل يجوز لآلية إعادة المحاولة الآلية أن تعيد هذا الطلب كما هو؟ */
  get isRetryable(): boolean {
    return this.errorClass === "RETRYABLE";
  }

  /** هل يجب تحديث البيانات قبل إعادة المحاولة؟ */
  get needsRefresh(): boolean {
    return this.errorClass === "REFRESH_THEN_RETRY";
  }

  /** هل هذا خطأ يمنع أي إعادة محاولة آلية؟ */
  get isFatal(): boolean {
    return this.errorClass === "FATAL" || this.errorClass === "DUPLICATE";
  }
}

export function classifyErrorCode(code: string): ErrorClass {
  return Object.hasOwn(ERROR_RULES, code) ? ERROR_RULES[code].class : "FATAL";
}
