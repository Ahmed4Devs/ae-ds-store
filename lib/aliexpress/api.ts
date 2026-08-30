import { env } from "@/lib/env";
import { callAe } from "./client";
import { AeApiError } from "./errors";
import {
  aeCategoryResponseSchema,
  aeDeliveryOptionSchema,
  aeFreightQueryResponseSchema,
  aeOrderCreateResponseSchema,
  aeOrderDetailResponseSchema,
  aeProductGetResponseSchema,
  aeTextSearchResponseSchema,
  aeTrackingResponseSchema,
  type AeDeliveryOption,
} from "./schemas";

/**
 * أغلفة مكتوبة النوع لواجهات فئة AE-Dropshipper.
 *
 * كل دالة هنا تقابل واجهة موثّقة واحدة، وتُعيد شكلًا مطبّعًا يسهل استهلاكه
 * في بقية التطبيق بدل تمرير استجابات المنصة الخام بأسمائها المتضاربة.
 */

// ===========================================================================
//  البحث — aliexpress.ds.text.search  (لا يتطلب access_token)
// ===========================================================================

export interface SearchParams {
  keyword?: string;
  categoryId?: string;
  page?: number;
  pageSize?: number;
  sortBy?:
    | "min_price,asc"
    | "min_price,desc"
    | "orders,asc"
    | "orders,desc"
    | "comments,asc"
    | "comments,desc";
}

export interface SearchResultItem {
  aeProductId: string;
  title: string;
  imageUrl: string;
  sourcePrice: number;
  sourceOriginalPrice: number | null;
  currency: string;
  discountLabel: string | null;
  ordersCount: number;
  rating: number | null;
  categoryId: string | null;
  /** "search" أو "recommend" — لا يُرتّبان بالمنطق نفسه */
  resultType: string | null;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  page: number;
  pageSize: number;
}

export async function searchProducts(p: SearchParams = {}): Promise<SearchResult> {
  const cfg = env();
  const page = p.page ?? 1;
  const pageSize = p.pageSize ?? 20;

  const { data } = await callAe(
    "aliexpress.ds.text.search",
    {
      keyWord: p.keyword ?? "",
      local: "en_US",
      countryCode: cfg.STORE_COUNTRY,
      currency: cfg.AE_SOURCE_CURRENCY,
      categoryId: p.categoryId,
      sortBy: p.sortBy,
      pageIndex: page,
      pageSize,
    },
    { requiresAuth: false },
  );

  const parsed = aeTextSearchResponseSchema.parse(data);
  const products = parsed.data?.products ?? [];

  return {
    items: products.map((it) => ({
      aeProductId: it.itemId,
      title: it.title,
      imageUrl: it.itemMainPic ?? "",
      sourcePrice: it.targetSalePrice ?? it.salePrice ?? 0,
      sourceOriginalPrice: it.targetOriginalPrice ?? it.originalPrice ?? null,
      currency: it.salePriceCurrency ?? cfg.AE_SOURCE_CURRENCY,
      discountLabel: it.discount ?? null,
      ordersCount: Number(it.orders ?? 0) || 0,
      rating: it.score ? Number(it.score) : null,
      categoryId: it.cateId ?? null,
      resultType: it.type ?? null,
    })),
    total: parsed.data?.totalCount ?? products.length,
    page,
    pageSize,
  };
}

// ===========================================================================
//  تفاصيل المنتج — aliexpress.ds.product.get  (يتطلب access_token)
// ===========================================================================

export interface ProductSkuDetail {
  aeSkuId: string;
  /** ⚠️ هذا ما يُرسَل في ds.order.create — وليس aeSkuId */
  skuAttr: string;
  variantLabel: string;
  imageUrl: string | null;
  sourcePrice: number;
  bulkPrice: number | null;
  bulkMinQty: number | null;
  stock: number;
}

export interface ProductDetail {
  aeProductId: string;
  title: string;
  descriptionHtml: string | null;
  categoryId: string | null;
  currency: string;
  imageUrls: string[];
  rating: number | null;
  ordersCount: number;
  properties: Array<{ name: string; value: string }>;
  skus: ProductSkuDetail[];
}

export async function getProduct(aeProductId: string): Promise<ProductDetail> {
  const cfg = env();

  const { data } = await callAe("aliexpress.ds.product.get", {
    product_id: aeProductId,
    ship_to_country: cfg.STORE_COUNTRY,
    target_currency: cfg.AE_SOURCE_CURRENCY,
    target_language: "en",
    remove_personal_benefit: false,
  });

  const parsed = aeProductGetResponseSchema.parse(data);
  const result = parsed.result;

  if (!result?.ae_item_base_info_dto) {
    throw new AeApiError({
      apiName: "aliexpress.ds.product.get",
      code: "ITEM_ID_NOT_FOUND",
    });
  }

  const base = result.ae_item_base_info_dto;
  const images = (result.ae_multimedia_info_dto?.image_urls ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawSkus = result.ae_item_sku_info_dtos?.ae_item_sku_info_d_t_o ?? [];

  const skus: ProductSkuDetail[] = rawSkus
    // بلا sku_attr لا يمكن تقديم طلبية — نستبعدها بدل أن تفشل لاحقًا
    .filter((s) => Boolean(s.sku_attr))
    .map((s) => {
      const props = s.ae_sku_property_dtos?.ae_sku_property_d_t_o ?? [];
      const label =
        props
          .map(
            (p) =>
              p.property_value_definition_name ?? p.sku_property_value ?? "",
          )
          .filter(Boolean)
          .join(" · ") || "افتراضي";

      return {
        aeSkuId: String(s.sku_id ?? ""),
        skuAttr: s.sku_attr as string,
        variantLabel: label,
        imageUrl: s.sku_image ?? null,
        sourcePrice: s.offer_sale_price ?? s.sku_price ?? 0,
        bulkPrice: s.offer_bulk_sale_price ?? null,
        bulkMinQty: s.sku_bulk_order ?? null,
        stock: s.sku_available_stock ?? 0,
      };
    });

  return {
    aeProductId: String(base.product_id ?? aeProductId),
    title: base.subject ?? "",
    descriptionHtml: base.detail ?? null,
    categoryId: base.category_id ? String(base.category_id) : null,
    currency: base.currency_code ?? cfg.AE_SOURCE_CURRENCY,
    imageUrls: images,
    rating: base.avg_evaluation_rating ? Number(base.avg_evaluation_rating) : null,
    ordersCount: Number(base.sales_count ?? 0) || 0,
    properties: (result.ae_item_properties?.ae_item_property ?? []).map((p) => ({
      name: p.attr_name ?? "",
      value: p.attr_value ?? "",
    })),
    skus,
  };
}

// ===========================================================================
//  الشحن — aliexpress.ds.freight.query  (يتطلب access_token)
// ===========================================================================

export interface ShippingOption {
  /** يُمرَّر حرفيًا كـ logistics_service_name عند إنشاء الطلبية */
  code: string;
  company: string;
  feeSource: number;
  currency: string;
  isFree: boolean;
  minDays: number | null;
  maxDays: number | null;
  /** إن كانت false فلا رقم تتبع للعميل */
  hasTracking: boolean;
  shipFromCountry: string | null;
  availableStock: number | null;
  /** هل الرسوم شاملة ضريبة القيمة المضافة DDP */
  includesVat: boolean;
}

function normalizeOption(o: AeDeliveryOption, fallbackCurrency: string): ShippingOption {
  return {
    code: o.code,
    company: o.company ?? o.code,
    feeSource: o.shipping_fee_cent ?? 0,
    currency: o.shipping_fee_currency ?? fallbackCurrency,
    isFree: o.free_shipping ?? false,
    minDays: o.min_delivery_days ?? null,
    maxDays: o.max_delivery_days ?? null,
    hasTracking: o.tracking ?? false,
    shipFromCountry: o.ship_from_country ?? null,
    availableStock: o.available_stock ?? null,
    includesVat: o.ddpIncludeVATTax ?? false,
  };
}

export interface FreightParams {
  aeProductId: string;
  quantity: number;
  /** يُدعّم البحث حسب المنطقة داخل السعودية */
  provinceCode?: string;
  cityCode?: string;
}

export async function getShippingOptions(
  p: FreightParams,
): Promise<ShippingOption[]> {
  const cfg = env();

  const { data } = await callAe("aliexpress.ds.freight.query", {
    queryDeliveryReq: JSON.stringify({
      productId: p.aeProductId,
      quantity: p.quantity,
      shipToCountry: cfg.STORE_COUNTRY,
      language: "en_US",
      locale: cfg.STORE_LOCALE,
      ...(p.provinceCode ? { provinceCode: p.provinceCode } : {}),
      ...(p.cityCode ? { cityCode: p.cityCode } : {}),
    }),
  });

  const parsed = aeFreightQueryResponseSchema.parse(data);
  const options = parsed.result?.delivery_options ?? [];

  return options
    .map((o) => normalizeOption(aeDeliveryOptionSchema.parse(o), cfg.AE_SOURCE_CURRENCY))
    .sort((a, b) => a.feeSource - b.feeSource);
}

// ===========================================================================
//  إنشاء الطلبية — aliexpress.ds.order.create  (يتطلب access_token)
// ===========================================================================

export interface PlaceOrderItem {
  aeProductId: string;
  /** من ProductSkuDetail.skuAttr — لا تستخدم aeSkuId هنا */
  skuAttr: string;
  quantity: number;
  /** من ShippingOption.code حرفيًا */
  logisticsServiceName: string;
  memo?: string;
}

export interface PlaceOrderAddress {
  country: string;
  province: string;
  city: string;
  addressLine1: string;
  addressLine2?: string;
  postalCode?: string;
  fullName: string;
  phone: string;
  phoneCountry?: string;
  /** رمز العنوان الوطني السعودي */
  nationalAddress?: string;
}

export interface PlaceOrderResult {
  /** معرّفات الطلبيات على AliExpress — مصفوفة لأن الطلبية قد تنقسم */
  aeOrderIds: string[];
}

export async function placeOrder(input: {
  /** مفتاح منع التكرار — رقم طلبية متجرنا */
  outOrderId: string;
  address: PlaceOrderAddress;
  items: PlaceOrderItem[];
  /** false أثناء الاختبار؛ true يدفع فعليًا ويتطلب حسابًا مفوَّضًا كدروبشيبينغ */
  tryToPay?: boolean;
  orderId?: string;
}): Promise<PlaceOrderResult> {
  const cfg = env();

  const dto = {
    out_order_id: input.outOrderId,
    logistics_address: {
      country: input.address.country,
      province: input.address.province,
      city: input.address.city,
      address: input.address.addressLine1,
      address2: input.address.addressLine2 ?? "",
      zip: input.address.postalCode ?? "",
      full_name: input.address.fullName,
      contact_person: input.address.fullName,
      mobile_no: input.address.phone,
      phone_country: input.address.phoneCountry ?? "+966",
      locale: cfg.STORE_LOCALE,
    },
    product_items: input.items.map((it) => ({
      product_id: it.aeProductId,
      sku_attr: it.skuAttr,
      product_count: it.quantity,
      logistics_service_name: it.logisticsServiceName,
      ...(it.memo ? { order_memo: it.memo } : {}),
    })),
  };

  const extend: Record<string, unknown> = {
    payment: {
      pay_currency: cfg.AE_SOURCE_CURRENCY,
      try_to_pay: String(input.tryToPay ?? false),
    },
    trade_extra_param: {
      business_model: "retail",
      // العنوان الوطني السعودي — حقل خاص بالسوق السعودي في التوثيق
      ...(input.address.nationalAddress
        ? { nat_addr: input.address.nationalAddress }
        : {}),
    },
  };

  const { data } = await callAe(
    "aliexpress.ds.order.create",
    {
      param_place_order_request4_open_api_d_t_o: JSON.stringify(dto),
      ds_extend_request: JSON.stringify(extend),
    },
    { orderId: input.orderId, timeoutMs: 45_000 },
  );

  const parsed = aeOrderCreateResponseSchema.parse(data);
  const result = parsed.result;

  if (!result?.is_success) {
    throw new AeApiError({
      apiName: "aliexpress.ds.order.create",
      code: result?.error_code || "ERROR_WHEN_BUILD_FOR_PLACE_ORDER",
      message: result?.error_msg ?? undefined,
    });
  }

  return { aeOrderIds: result.order_list };
}

// ===========================================================================
//  ما بعد الدفع — aliexpress.ds.order.afterpay
// ===========================================================================

export async function orderAfterPay(aeOrderId: string): Promise<boolean> {
  const { data } = await callAe("aliexpress.ds.order.afterpay", {
    req: JSON.stringify({ order_id: aeOrderId }),
  });
  const d = data as { result?: unknown };
  return String(d?.result ?? "false") === "true";
}

// ===========================================================================
//  تفاصيل الطلبية — aliexpress.trade.ds.order.get
// ===========================================================================

export interface AeOrderDetail {
  orderStatus: string | null;
  logisticsStatus: string | null;
  /** الثواني المتبقية حتى انتهاء مهلة الدفع — انقضاؤها يعني إلغاءً تلقائيًا */
  payTimeoutSecond: number | null;
  amountBreakdown: unknown;
}

export async function getOrderDetail(aeOrderId: string): Promise<AeOrderDetail> {
  const { data } = await callAe("aliexpress.trade.ds.order.get", {
    single_order_query: JSON.stringify({ order_id: aeOrderId }),
  });

  const parsed = aeOrderDetailResponseSchema.parse(data);
  const r = parsed.result;

  return {
    orderStatus: r?.order_status ?? null,
    logisticsStatus: r?.logistics_status ?? null,
    payTimeoutSecond: r?.pay_timeout_second ?? null,
    amountBreakdown: r?.child_order_list ?? [],
  };
}

// ===========================================================================
//  التتبع — aliexpress.ds.order.tracking.get
// ===========================================================================

export interface TrackingNode {
  title: string;
  description: string;
  at: Date;
}

export interface TrackingPackageInfo {
  mailNo: string;
  carrierName: string | null;
  cpName: string | null;
  cpWebsiteUrl: string | null;
  etaAt: Date | null;
  nodes: TrackingNode[];
}

export async function getTracking(
  aeOrderId: string,
): Promise<TrackingPackageInfo[]> {
  try {
    const { data } = await callAe("aliexpress.ds.order.tracking.get", {
      ae_order_id: aeOrderId,
      language: "en_US",
    });

    const parsed = aeTrackingResponseSchema.parse(data);
    const lines = parsed.result?.data?.tracking_detail_line_list ?? [];

    return lines
      .filter((l) => Boolean(l.mail_no))
      .map((l) => ({
        mailNo: l.mail_no as string,
        carrierName: l.carrier_name ?? null,
        cpName: l.cp_name ?? null,
        cpWebsiteUrl: l.cp_website_url ?? null,
        etaAt: l.eta_time_stamps ? new Date(l.eta_time_stamps) : null,
        nodes: (l.detail_node_list ?? [])
          .map((n) => ({
            title: n.tracking_name ?? "",
            description: n.tracking_detail_desc ?? "",
            at: new Date(n.time_stamp ?? Date.now()),
          }))
          .sort((a, b) => b.at.getTime() - a.at.getTime()),
      }));
  } catch (e) {
    // غياب بيانات التتبع قبل الشحن حالة طبيعية موثّقة، لا خطأ يُعرض للعميل
    if (e instanceof AeApiError && e.code === "TRACKING DATA NOT FOUND") {
      return [];
    }
    throw e;
  }
}

// ===========================================================================
//  الفئات — aliexpress.ds.category.get  (لا يتطلب access_token)
// ===========================================================================

export interface AeCategory {
  categoryId: string;
  categoryName: string;
}

export async function getCategories(): Promise<AeCategory[]> {
  const { data } = await callAe(
    "aliexpress.ds.category.get",
    { language: "ar" },
    { requiresAuth: false },
  );

  const parsed = aeCategoryResponseSchema.parse(data);
  return (parsed.resp_result?.result?.categories ?? []).map((c) => ({
    categoryId: String(c.category_id),
    categoryName: c.category_name,
  }));
}
