// لا تكفي صيغة محارف آمنة: يستطيع مزوّد خارجي تعيين Error.name/code إلى
// قيمة عالية التنوّع ثم استخدامها قناةً جانبية في السجل. القائمة المغلقة
// تبقي البطاقة منخفضة التنوّع فعلًا ولا تمرر code أو نص الخطأ مطلقًا.
const SAFE_ERROR_NAMES = new Set([
    "AbortError",
    "AeApiError",
    "ApiError",
    "CartLimitError",
    "Error",
    "FxRateRangeError",
    "PaymentError",
    "PrismaClientInitializationError",
    "PrismaClientKnownRequestError",
    "PrismaClientRustPanicError",
    "PrismaClientUnknownRequestError",
    "PrismaClientValidationError",
    "RangeError",
    "ResponseBodyTooLargeError",
    "SyntaxError",
    "TimeoutError",
    "TypeError",
    "URIError",
  "ZodError",
]);

/**
 * Returns a low-cardinality error label that is safe for operational logs.
 * Error messages and stacks can contain credentials, provider payloads, SQL
 * fragments, or customer data, so callers must not log them directly.
 */
export function safeErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";

  return SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
}
