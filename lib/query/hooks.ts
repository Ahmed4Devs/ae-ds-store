"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { apiGet, qs } from "./fetcher";
import { queryKeys } from "./keys";
import type {
  AdminOrdersDto,
  OrderTrackingDto,
  ShippingOptionDto,
} from "./keys";
import {
  addToCartAction,
  clearCartAction,
  updateCartAction,
} from "@/app/actions/cart";

/**
 * خطّافات الاستعلام والتعديل.
 *
 * تقسيم المسؤوليات مقصود:
 *   - القراءة عبر مسارات API لأن TanStack يحتاج نقطة نهاية قابلة
 *     لإعادة الجلب والاستقصاء.
 *   - الكتابة عبر إجراءات الخادم لأنها أبسط وأكثر أمانًا، وتغلَّف
 *     بـ useMutation للحصول على التحديث المتفائل وإبطال الذاكرة.
 */

// ===========================================================================
//  الشحن — يُعاد حسابه عند تغيّر الكمية
// ===========================================================================

export function useShippingOptions(
  aeProductId: string,
  quantity: number,
  initialData?: ShippingOptionDto[],
) {
  return useQuery({
    queryKey: queryKeys.shipping(aeProductId, quantity),
    queryFn: ({ signal }) =>
      apiGet<ShippingOptionDto[]>(
        `/api/shipping${qs({ productId: aeProductId, quantity })}`,
        { signal },
      ),
    // بيانات الخادم للكمية الأولى فقط — بقية الكميات تُجلب عند الطلب
    initialData: quantity === 1 ? initialData : undefined,
    // أجرة الشحن قد تتغيّر لدى المصدر، فلا تُخزَّن طويلًا
    staleTime: 2 * 60_000,
    placeholderData: (previous) => previous,
  });
}

// ===========================================================================
//  تتبّع الطلبية — استقصاء دوري
// ===========================================================================

/** حالات لم تعد تتغيّر، فيتوقف الاستقصاء عندها. */
const TERMINAL_STATUSES = new Set(["DELIVERED", "CANCELLED"]);

export function useOrderTracking(
  orderNumber: string,
  initialData?: OrderTrackingDto,
) {
  return useQuery({
    queryKey: queryKeys.orderTracking(orderNumber),
    queryFn: ({ signal }) =>
      apiGet<OrderTrackingDto>(`/api/orders/${orderNumber}/tracking`, { signal }),
    initialData,
    /**
     * الاستقصاء كل دقيقتين ما دامت الطلبية نشطة.
     * السبب موثّق: واجهات AliExpress بلا إشعارات فورية. والخادم يحرس
     * فاصلًا أدنى قدره عشر دقائق قبل مخاطبة المنصة، فهذا الاستقصاء
     * يقرأ قاعدة البيانات غالبًا لا الواجهة الخارجية.
     */
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) return false;
      return 120_000;
    },
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// ===========================================================================
//  لوحة الإدارة
// ===========================================================================

export function useAdminOrders(
  status: string | undefined,
  review: boolean,
  page: number,
  initialData?: AdminOrdersDto,
) {
  return useQuery({
    queryKey: queryKeys.adminOrders(status, review, page),
    queryFn: ({ signal }) =>
      apiGet<AdminOrdersDto>(
        `/api/admin/orders${qs({
          status,
          review: review ? "true" : undefined,
          page: page > 1 ? page : undefined,
        })}`,
        { signal },
      ),
    initialData,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// ===========================================================================
//  السلة — تعديلات عبر إجراءات الخادم
// ===========================================================================

export function useAddToCart() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      aeProductId: string;
      skuAttr: string;
      quantity: number;
      logisticsServiceName: string;
    }) => {
      const res = await addToCartAction(input);
      if (!res.ok) throw new Error(res.error);
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cart"] });
      router.push("/cart");
    },
  });
}

export function useUpdateCartItem() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      aeProductId: string;
      skuAttr: string;
      logisticsServiceName: string;
      quantity: number;
    }) => {
      const res = await updateCartAction(input);
      if (!res.ok) throw new Error(res.error);
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cart"] });
      // السلة تُصيَّر على الخادم، فيلزم تحديثها بعد التعديل
      router.refresh();
    },
  });
}

export function useClearCart() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => clearCartAction(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cart"] });
      router.refresh();
    },
  });
}
