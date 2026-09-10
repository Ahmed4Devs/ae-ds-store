import type { Locale } from "@/lib/i18n/shared";

export const ADMIN_ORDERS_PAGE_SIZE = 50;
export const ADMIN_ORDERS_MAX_PAGE = 10_000;

/**
 * رقم صفحة موجب بصيغة عشرية canonical وحدّ صريح يمنع offsets باهظة.
 * غياب المعامل يعني الصفحة الأولى، أما 01/1.0/+1 والمساحات فتُرفض.
 */
export function parseAdminOrdersPage(
  value: string | null | undefined,
): number | null {
  if (value == null) return 1;
  if (!/^[1-9]\d{0,4}$/u.test(value)) return null;
  const page = Number(value);
  return page <= ADMIN_ORDERS_MAX_PAGE ? page : null;
}

/**
 * مفاتيح الاستعلامات.
 *
 * تُجمَّع في مصنع واحد لا تُكتب نصًا في المكوّنات: المفتاح الخاطئ لا
 * يُنتج خطأ ترجمة بل ذاكرة مؤقتة لا تُبطَل أبدًا — وهو عطب صامت.
 */
export const queryKeys = {
  shipping: (aeProductId: string, quantity: number) =>
    ["shipping", aeProductId, quantity] as const,

  cartSummary: (locale: Locale) => ["cart", "summary", locale] as const,

  orderTracking: (orderNumber: string) =>
    ["orders", orderNumber, "tracking"] as const,

  adminOrders: (status?: string, review = false, page = 1) =>
    [
      "admin",
      "orders",
      status ?? "all",
      review ? "review" : "all",
      page,
    ] as const,

  adminStats: () => ["admin", "stats"] as const,
} as const;

/** أنواع الاستجابات المشتركة بين مسارات API والعميل. */

export interface ShippingOptionDto {
  code: string;
  company: string;
  feeSar: number;
  isFree: boolean;
  hasTracking: boolean;
  estimate: string;
  minDays: number | null;
  maxDays: number | null;
  availableStock: number | null;
}

export interface TrackingNodeDto {
  title: string;
  description: string;
  at: string;
}

export interface TrackingPackageDto {
  mailNo: string;
  carrierName: string | null;
  cpName: string | null;
  cpWebsiteUrl: string | null;
  etaAt: string | null;
  nodes: TrackingNodeDto[];
}

export interface OrderTrackingDto {
  status: string;
  packages: TrackingPackageDto[];
  updatedAt: string;
}

export interface AdminOrderRowDto {
  id: string;
  orderNumber: string;
  status: string;
  needsManualReview: boolean;
  manualReviewCode: string | null;
  manualReviewOpenedAt: string | null;
  totalSar: number;
  costSar: number;
  marginSar: number;
  itemCount: number;
  aeOrderCount: number;
  createdAt: string;
}

export interface AdminStatsDto {
  totalOrders: number;
  needsAttention: number;
  revenueSar: number;
  grossMarginSar: number;
  failedCalls: number;
  fatalCalls: number;
}

export interface AdminOrdersDto {
  rows: AdminOrderRowDto[];
  stats: AdminStatsDto;
  totalFiltered: number;
  hasNext: boolean;
}
