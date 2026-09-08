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
  const page = Number.isSafeInteger(p.page) ? Math.min(100, Math.max(1, p.page!)) : 1;
  const pageSize = Number.isSafeInteger(p.pageSize)
    ? Math.min(100, Math.max(1, p.pageSize!))
    : 20;
  const keyword = safeDisplayText(p.keyword, 120);
  const categoryId = /^\d{1,32}$/u.test(p.categoryId ?? "")
    ? p.categoryId
    : undefined;
  const allowedSorts: ReadonlySet<string> = new Set([
    "min_price,asc",
    "min_price,desc",
    "orders,asc",
    "orders,desc",
    "comments,asc",
    "comments,desc",
  ]);
  const sortBy = typeof p.sortBy === "string" && allowedSorts.has(p.sortBy)
    ? p.sortBy
    : undefined;

  const { data } = await callAe(
    "aliexpress.ds.text.search",
    {
      keyWord: keyword,
      local: "en_US",
      countryCode: cfg.STORE_COUNTRY,
      currency: cfg.AE_SOURCE_CURRENCY,
      categoryId,
      sortBy,
      pageIndex: page,
      pageSize,
    },
    { requiresAuth: false },
  );

  const parsed = aeTextSearchResponseSchema.parse(data);
  const products = parsed.data?.products ?? [];

  const items = products.flatMap((it): SearchResultItem[] => {
    const aeProductId = it.itemId.trim();
    const title = safeDisplayText(it.title, 500);
    const imageUrl = safeImageUrl(it.itemMainPic, cfg.AE_MODE === "mock");
    const currency = (it.salePriceCurrency ?? cfg.AE_SOURCE_CURRENCY)
      .trim()
      .toUpperCase();
    const sourcePrice =
      positiveMoney(it.targetSalePrice) ?? positiveMoney(it.salePrice);

    // بيانات بطاقة غير قابلة للتحقق لا تتحول إلى سعر صفري أو رابط غير موثوق.
    if (
      !/^\d{5,32}$/u.test(aeProductId) ||
      !title ||
      !imageUrl ||
      currency !== cfg.AE_SOURCE_CURRENCY ||
      sourcePrice == null
    ) {
      return [];
    }

    const rawOriginal =
      positiveMoney(it.targetOriginalPrice) ?? positiveMoney(it.originalPrice);
    const rawOrders = Number(it.orders ?? 0);
    const rawRating = Number(it.score ?? Number.NaN);

    return [{
      aeProductId,
      title,
      imageUrl,
      sourcePrice,
      sourceOriginalPrice:
        rawOriginal != null && rawOriginal >= sourcePrice ? rawOriginal : null,
      currency,
      discountLabel: safeDisplayText(it.discount, 128) || null,
      ordersCount:
        Number.isSafeInteger(rawOrders) && rawOrders >= 0
          ? Math.min(rawOrders, 1_000_000_000)
          : 0,
      rating:
        Number.isFinite(rawRating) && rawRating >= 0 && rawRating <= 5
          ? rawRating
          : null,
      categoryId: /^\d{1,32}$/u.test(it.cateId ?? "") ? (it.cateId ?? null) : null,
      resultType: safeDisplayText(it.type, 32) || null,
    }];
  });

  const rawTotal = parsed.data?.totalCount;
  return {
    items,
    total:
      rawTotal != null && Number.isSafeInteger(rawTotal) && rawTotal >= 0
        ? Math.min(rawTotal, 100_000_000)
        : items.length,
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
  /** نص موثوق للعرض عبر React؛ لا نحتفظ بـ HTML المورّد القابل للحقن. */
  descriptionText: string | null;
  categoryId: string | null;
  currency: string;
  imageUrls: string[];
  rating: number | null;
  ordersCount: number;
  properties: Array<{ name: string; value: string }>;
  skus: ProductSkuDetail[];
}

function positiveMoney(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 && value <= 1_000_000_000
    ? value
    : null;
}

function safeDisplayText(
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function safeDescriptionText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // القيمة من مزوّد خارجي. حتى إن كان العرض الحالي لا يستخدم innerHTML،
  // تخزين HTML خام يجعل إضافة مستقبلية واحدة باب XSS مخزّن. نحوله إلى نص
  // محدود؛ 32k code units تبقى دون قيد PostgreSQL ذي 128KiB حتى مع UTF-8.
  const text = value
    .replace(/<[^>]*>/gu, " ")
    // وسوم مبتورة مثل `<script` لا يلتقطها التعبير السابق؛ نزيل علامتي
    // الوسم كذلك كي يبقى الحقل نصًا خالصًا تدعمه قيود قاعدة البيانات.
    .replace(/[<>]/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 32_000);
  return text || null;
}

function safeHttpsUrl(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 4_096) return null;

  try {
    const parsed = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeImageUrl(
  value: unknown,
  allowMockDataUrl: boolean,
): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    allowMockDataUrl &&
    (trimmed.startsWith("data:image/svg+xml,") ||
      trimmed.startsWith("data:image/svg+xml;utf8,")) &&
    trimmed.length <= 4_096
  ) {
    return trimmed;
  }
  return safeHttpsUrl(trimmed);
}

function safeProviderDate(value: number | null | undefined): Date | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const earliest = Date.UTC(2000, 0, 1);
  const latest = Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < earliest || milliseconds > latest) {
    return null;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validStock(value: number | null | undefined): number | null {
  if (value == null) return 0;
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : null;
}

function upstreamFinancialError(apiName: string, message: string): AeApiError {
  return new AeApiError({
    apiName,
    code: "INVALID_UPSTREAM_FINANCIAL_DATA",
    message,
  });
}

export async function getProduct(aeProductId: string): Promise<ProductDetail> {
  const cfg = env();

  if (!/^\d{5,32}$/u.test(aeProductId)) {
    throw new AeApiError({
      apiName: "aliexpress.ds.product.get",
      code: "ITEM_ID_NOT_FOUND",
    });
  }

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
  const returnedProductId = String(base.product_id ?? aeProductId);
  if (returnedProductId !== aeProductId) {
    throw upstreamFinancialError(
      "aliexpress.ds.product.get",
      "معرّف المنتج في الاستجابة لا يطابق المنتج المطلوب",
    );
  }
  const currency = (base.currency_code ?? cfg.AE_SOURCE_CURRENCY)
    .trim()
    .toUpperCase();
  if (currency !== cfg.AE_SOURCE_CURRENCY) {
    throw upstreamFinancialError(
      "aliexpress.ds.product.get",
      `عملة المنتج غير متوقعة: ${currency}`,
    );
  }
  const images = (result.ae_multimedia_info_dto?.image_urls ?? "")
    .split(";")
    .map((s) => safeImageUrl(s, cfg.AE_MODE === "mock"))
    .filter((url): url is string => url != null)
    .slice(0, 20);
  if (images.length === 0) {
    throw upstreamFinancialError(
      "aliexpress.ds.product.get",
      "لم تُرجع المنصة صورة منتج آمنة قابلة للعرض",
    );
  }

  const rawSkus = result.ae_item_sku_info_dtos?.ae_item_sku_info_d_t_o ?? [];

  const skus: ProductSkuDetail[] = rawSkus.flatMap((s) => {
      // بلا sku_attr أو سعر موجب أو مخزون صحيح لا يمكن بيع الوحدة بأمان.
      const skuAttr = s.sku_attr?.trim() ?? "";
      const skuCurrency = (s.currency_code ?? currency).trim().toUpperCase();
      const sourcePrice =
        positiveMoney(s.offer_sale_price) ?? positiveMoney(s.sku_price);
      const stock = validStock(s.sku_available_stock);
      if (
        !skuAttr ||
        skuAttr.length > 96 ||
        /[\u0000-\u001f\u007f]/u.test(skuAttr) ||
        skuCurrency !== cfg.AE_SOURCE_CURRENCY ||
        sourcePrice == null ||
        stock == null
      ) {
        return [];
      }

      const props = s.ae_sku_property_dtos?.ae_sku_property_d_t_o ?? [];
      const label = safeDisplayText(
        props
          .map(
            (p) =>
              p.property_value_definition_name ?? p.sku_property_value ?? "",
          )
          .filter(Boolean)
          .join(" · ") || "افتراضي",
        1_000,
      );

      const bulkPrice = positiveMoney(s.offer_bulk_sale_price);
      const bulkMinQty =
        s.sku_bulk_order != null &&
        Number.isSafeInteger(s.sku_bulk_order) &&
        s.sku_bulk_order > 0
          ? s.sku_bulk_order
          : null;

      return [{
        aeSkuId: safeDisplayText(s.sku_id, 128),
        skuAttr,
        variantLabel: label,
        imageUrl: safeImageUrl(s.sku_image, cfg.AE_MODE === "mock"),
        sourcePrice,
        bulkPrice,
        bulkMinQty,
        stock,
      }];
    });

  if (skus.length === 0) {
    throw upstreamFinancialError(
      "aliexpress.ds.product.get",
      "لم تُرجع المنصة أي SKU بسعر ومخزون وعملة صالحة",
    );
  }

  return {
    aeProductId: returnedProductId,
    title: safeDisplayText(base.subject, 1_000),
    descriptionText: safeDescriptionText(base.detail),
    categoryId: base.category_id ? String(base.category_id) : null,
    currency,
    imageUrls: images,
    rating: base.avg_evaluation_rating ? Number(base.avg_evaluation_rating) : null,
    ordersCount: Number(base.sales_count ?? 0) || 0,
    properties: (result.ae_item_properties?.ae_item_property ?? [])
      .map((p) => ({
        name: safeDisplayText(p.attr_name, 1_000),
        value: safeDisplayText(p.attr_value, 4_096),
      }))
      .filter((property) => property.name || property.value),
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

function normalizeOption(
  o: AeDeliveryOption,
  expectedCurrency: string,
): ShippingOption | null {
  const code = o.code.trim();
  const currency = (o.shipping_fee_currency ?? expectedCurrency)
    .trim()
    .toUpperCase();
  const fee = o.shipping_fee_cent ?? 0;
  const availableStock = o.available_stock ?? null;
  const minDays = o.min_delivery_days ?? null;
  const maxDays = o.max_delivery_days ?? null;
  if (
    !/^[A-Za-z0-9_.:-]{1,64}$/u.test(code) ||
    currency !== expectedCurrency ||
    !Number.isFinite(fee) ||
    fee < 0 ||
    fee > 1_000_000_000 ||
    (availableStock != null &&
      (!Number.isSafeInteger(availableStock) || availableStock < 0)) ||
    (minDays != null && (!Number.isSafeInteger(minDays) || minDays < 0)) ||
    (maxDays != null && (!Number.isSafeInteger(maxDays) || maxDays < 0)) ||
    (minDays != null && maxDays != null && minDays > maxDays)
  ) {
    return null;
  }

  return {
    code,
    company: o.company ?? code,
    feeSource: fee,
    currency,
    isFree: o.free_shipping ?? false,
    minDays,
    maxDays,
    hasTracking: o.tracking ?? false,
    shipFromCountry: o.ship_from_country ?? null,
    availableStock,
    includesVat: o.ddpIncludeVATTax ?? false,
  };
}

export interface FreightParams {
  aeProductId: string;
  quantity: number;
  /** اسم المحافظة كما تقبله queryDeliveryReq.province. */
  province?: string;
  /** رمز المحافظة؛ لا يُرسل مع province في الطلب نفسه. */
  provinceCode?: string;
  cityCode?: string;
}

export async function getShippingOptions(
  p: FreightParams,
): Promise<ShippingOption[]> {
  const cfg = env();

  if (
    !/^\d{5,32}$/u.test(p.aeProductId) ||
    !Number.isSafeInteger(p.quantity) ||
    p.quantity < 1 ||
    p.quantity > 50 ||
    (p.province != null && p.provinceCode != null) ||
    [p.province, p.provinceCode, p.cityCode].some(
      (value) =>
        value != null &&
        (value.trim().length === 0 ||
          value.length > 64 ||
          /[\u0000-\u001f\u007f]/u.test(value)),
    )
  ) {
    throw new AeApiError({
      apiName: "aliexpress.ds.freight.query",
      code: "INVALID_LOCAL_INPUT",
    });
  }

  const { data } = await callAe("aliexpress.ds.freight.query", {
    queryDeliveryReq: JSON.stringify({
      productId: p.aeProductId,
      quantity: p.quantity,
      shipToCountry: cfg.STORE_COUNTRY,
      language: "en_US",
      locale: cfg.STORE_LOCALE,
      ...(p.province ? { province: p.province } : {}),
      ...(p.provinceCode ? { provinceCode: p.provinceCode } : {}),
      ...(p.cityCode ? { cityCode: p.cityCode } : {}),
    }),
  });

  const parsed = aeFreightQueryResponseSchema.parse(data);
  const options = parsed.result?.delivery_options ?? [];

  return options
    .map((o) => normalizeOption(aeDeliveryOptionSchema.parse(o), cfg.AE_SOURCE_CURRENCY))
    .filter((option): option is ShippingOption => option !== null)
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

  const parsed = aeOrderCreateResponseSchema.safeParse(data);
  if (!parsed.success) {
    // ردّ يدّعي النجاح بلا معرّفات حالة غامضة: قد يكون الشراء وقع فعلًا.
    // لا نرمي ZodError عامةً كي يستطيع محرّك الطلبيات إيقاف الإعادة ورفع
    // الطلب للمطابقة اليدوية بدل إعادة شراء محتملة.
    throw new AeApiError({
      apiName: "aliexpress.ds.order.create",
      code: "INVALID_ORDER_CREATE_RESPONSE",
      message: "استجابة إنشاء الطلبية غير قابلة للمطابقة",
    });
  }
  const result = parsed.data.result;

  if (!result?.is_success) {
    throw new AeApiError({
      apiName: "aliexpress.ds.order.create",
      code: result?.error_code || "ERROR_WHEN_BUILD_FOR_PLACE_ORDER",
      message: result?.error_msg ?? undefined,
    });
  }

  // دفاع أخير إن تغيّر المخطط لاحقًا: لا يُعلَن النجاح بلا أثر مورد فريد.
  if (
    result.order_list.length === 0 ||
    new Set(result.order_list).size !== result.order_list.length
  ) {
    throw new AeApiError({
      apiName: "aliexpress.ds.order.create",
      code: "INVALID_ORDER_CREATE_RESPONSE",
      message: "استجابة نجاح بلا معرّفات طلبيات فريدة",
    });
  }

  return { aeOrderIds: result.order_list };
}

// ===========================================================================
//  ما بعد الدفع — aliexpress.ds.order.afterpay
// ===========================================================================

export async function orderAfterPay(aeOrderId: string): Promise<boolean> {
  assertAeOrderId("aliexpress.ds.order.afterpay", aeOrderId);
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
  assertAeOrderId("aliexpress.trade.ds.order.get", aeOrderId);
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
    assertAeOrderId("aliexpress.ds.order.tracking.get", aeOrderId);
    const { data } = await callAe("aliexpress.ds.order.tracking.get", {
      ae_order_id: aeOrderId,
      language: "en_US",
    });

    const parsed = aeTrackingResponseSchema.parse(data);
    const lines = parsed.result?.data?.tracking_detail_line_list ?? [];

    return lines
      .filter((l) => Boolean(l.mail_no))
      .map((l) => ({
        mailNo: safeDisplayText(l.mail_no, 128),
        carrierName: safeDisplayText(l.carrier_name, 256) || null,
        cpName: safeDisplayText(l.cp_name, 256) || null,
        cpWebsiteUrl: safeHttpsUrl(l.cp_website_url),
        etaAt: safeProviderDate(l.eta_time_stamps),
        nodes: (l.detail_node_list ?? [])
          .flatMap((n): TrackingNode[] => {
            const at = safeProviderDate(n.time_stamp);
            if (!at) return [];
            return [{
              title: safeDisplayText(n.tracking_name, 512),
              description: safeDisplayText(n.tracking_detail_desc, 4_096),
              at,
            }];
          })
          .sort((a, b) => b.at.getTime() - a.at.getTime()),
      }))
      .filter((line) => Boolean(line.mailNo))
      .filter(
        (line, index, all) =>
          all.findIndex((candidate) => candidate.mailNo === line.mailNo) === index,
      );
  } catch (e) {
    // غياب بيانات التتبع قبل الشحن حالة طبيعية موثّقة، لا خطأ يُعرض للعميل
    if (e instanceof AeApiError && e.code === "TRACKING DATA NOT FOUND") {
      return [];
    }
    throw e;
  }
}

function assertAeOrderId(apiName: string, value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new AeApiError({ apiName, code: "INVALID_LOCAL_INPUT" });
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
