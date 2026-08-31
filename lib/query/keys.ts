import type { Locale } from "@/lib/i18n/shared";

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

  adminOrders: (status?: string) => ["admin", "orders", status ?? "all"] as const,

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
