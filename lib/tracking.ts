import type { TrackingNodeDto } from "@/lib/query/keys";

const MAX_NODES = 500;
const EARLIEST_TRACKING_DATE = Date.UTC(2000, 0, 1);
const LATEST_TRACKING_OFFSET_MS = 10 * 365 * 24 * 60 * 60 * 1_000;

function displayText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (
    !Number.isFinite(time) ||
    time < EARLIEST_TRACKING_DATE ||
    time > Date.now() + LATEST_TRACKING_OFFSET_MS
  ) {
    return null;
  }
  return date.toISOString();
}

/**
 * `nodes` حقل JSON لا تضمنه PostgreSQL بنوع TypeScript. نتحقق منه عند حدّ
 * القراءة أيضًا كي لا تُسقط قيمة تاريخ تالفة صفحة الطلب أو مسار الاستقصاء.
 */
export function serializeTrackingNodes(value: unknown): TrackingNodeDto[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, MAX_NODES).flatMap((candidate): TrackingNodeDto[] => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return [];
    }
    const node = candidate as Record<string, unknown>;
    const at = isoDate(node.at);
    if (!at) return [];
    return [{
      title: displayText(node.title, 512),
      description: displayText(node.description, 4_096),
      at,
    }];
  });
}
