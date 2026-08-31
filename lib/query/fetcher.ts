/**
 * طبقة الجلب المشتركة لاستعلامات العميل.
 *
 * تُستخدم `fetch` الأصلية لا axios: الأولى مدمجة في المتصفّح وفي Node،
 * وتتكامل مع طبقة التخزين المؤقت في Next.js، ولا تُضيف حجمًا إلى الحزمة.
 * ما تقدّمه axios زيادةً (المهلة والاعتراض ورمي الخطأ تلقائيًا) مُغطّى
 * هنا في نحو عشرين سطرًا.
 */

/** خطأ يحمل رمز الحالة حتى تقرر سياسة إعادة المحاولة بناءً عليه. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function apiGet<T>(
  path: string,
  { signal, timeoutMs = 20_000 }: FetchOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // دمج إشارة الإلغاء القادمة من المكتبة مع مهلتنا الخاصة
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const res = await fetch(path, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      let code: string | undefined;
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        code = body.error;
        message = body.message ?? body.error ?? message;
      } catch {
        // جسم غير JSON — نكتفي برمز الحالة
      }
      throw new ApiError(res.status, message, code);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** يبني سلسلة استعلام متجاهلًا القيم الفارغة. */
export function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
