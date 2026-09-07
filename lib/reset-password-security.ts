import "server-only";

/**
 * لا يظهر رمز الاستعادة في React props أو RSC. يلتقطه proxy من أول تحويل
 * ويضعه في كوكي HttpOnly قصيرة العمر ومحصورة بمسار صفحة الاستعادة.
 */
export const RESET_TOKEN_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Secure-ae_ds_reset"
    : "ae_ds_reset";

export const RESET_TOKEN_COOKIE_PATH = "/reset-password";
export const RESET_TOKEN_COOKIE_MAX_AGE = 15 * 60;

const RESET_TOKEN_PATTERN = /^[A-Za-z0-9]{24}$/;

export function isResetToken(value: string | undefined): value is string {
  return typeof value === "string" && RESET_TOKEN_PATTERN.test(value);
}
