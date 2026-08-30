import { z } from "zod";

/**
 * مخطّطات zod لاستجابات واجهات AliExpress.
 *
 * ملاحظة مهمة: المنصة تُعيد كثيرًا من القيم الرقمية والمنطقية على شكل
 * سلاسل نصية ("true"، "1.99"، "100")، كما هو ظاهر في أمثلة التوثيق.
 * لذلك نستخدم محوّلات متساهلة عند الإدخال وصارمة عند الإخراج.
 */

/** يقبل رقمًا أو سلسلة رقمية ويعيد رقمًا. */
const looseNumber = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: `قيمة رقمية غير صالحة: ${v}` });
      return z.NEVER;
    }
    return n;
  });

const looseNumberOptional = looseNumber.optional().nullable();

/** يقبل true/false أو "true"/"false" ويعيد قيمة منطقية. */
const looseBoolean = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const looseBooleanOptional = looseBoolean.optional().nullable();

// ===========================================================================
//  aliexpress.ds.text.search
// ===========================================================================

export const aeSearchProductSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  itemMainPic: z.string().optional().nullable(),
  itemUrl: z.string().optional().nullable(),
  salePrice: looseNumberOptional,
  salePriceCurrency: z.string().optional().nullable(),
  originalPrice: looseNumberOptional,
  originalPriceCurrency: z.string().optional().nullable(),
  targetSalePrice: looseNumberOptional,
  targetOriginalPrice: looseNumberOptional,
  discount: z.string().optional().nullable(),
  orders: z.string().optional().nullable(),
  score: z.string().optional().nullable(),
  evaluateRate: z.string().optional().nullable(),
  cateId: z.string().optional().nullable(),
  productVideoUrl: z.string().optional().nullable(),
  /** "search" لنتيجة بحث، "recommend" لنتيجة من محرك التوصية */
  type: z.string().optional().nullable(),
});

export const aeTextSearchResponseSchema = z.object({
  code: z.string().optional().nullable(),
  msg: z.string().optional().nullable(),
  data: z
    .object({
      totalCount: looseNumberOptional,
      pageIndex: looseNumberOptional,
      pageSize: looseNumberOptional,
      products: z.array(aeSearchProductSchema).default([]),
    })
    .optional()
    .nullable(),
});

export type AeSearchProduct = z.infer<typeof aeSearchProductSchema>;

// ===========================================================================
//  aliexpress.ds.product.get
// ===========================================================================

export const aeSkuSchema = z.object({
  sku_id: z.string().optional().nullable(),
  /** ⚠️ الحقل المطلوب في ds.order.create — لا تستخدم sku_id مكانه */
  sku_attr: z.string().optional().nullable(),
  sku_price: looseNumberOptional,
  offer_sale_price: looseNumberOptional,
  offer_bulk_sale_price: looseNumberOptional,
  sku_bulk_order: looseNumberOptional,
  sku_available_stock: looseNumberOptional,
  currency_code: z.string().optional().nullable(),
  sku_image: z.string().optional().nullable(),
  ae_sku_property_dtos: z
    .object({
      ae_sku_property_d_t_o: z
        .array(
          z.object({
            sku_property_id: looseNumberOptional,
            sku_property_name: z.string().optional().nullable(),
            sku_property_value: z.string().optional().nullable(),
            property_value_definition_name: z.string().optional().nullable(),
            sku_image: z.string().optional().nullable(),
          }),
        )
        .default([]),
    })
    .optional()
    .nullable(),
});

export const aePropertySchema = z.object({
  attr_name: z.string().optional().nullable(),
  attr_value: z.string().optional().nullable(),
  attr_name_id: looseNumberOptional,
  attr_value_id: looseNumberOptional,
  attr_value_unit: z.string().optional().nullable(),
});

export const aeProductGetResponseSchema = z.object({
  rsp_code: looseNumberOptional,
  rsp_msg: z.string().optional().nullable(),
  result: z
    .object({
      ae_item_base_info_dto: z
        .object({
          product_id: z.union([z.string(), z.number()]).optional().nullable(),
          subject: z.string().optional().nullable(),
          detail: z.string().optional().nullable(),
          category_id: looseNumberOptional,
          currency_code: z.string().optional().nullable(),
          product_status_type: z.string().optional().nullable(),
          evaluation_count: z.string().optional().nullable(),
          avg_evaluation_rating: z.string().optional().nullable(),
          sales_count: z.string().optional().nullable(),
        })
        .optional()
        .nullable(),
      ae_multimedia_info_dto: z
        .object({
          image_urls: z.string().optional().nullable(),
          ae_video_dtos: z.unknown().optional().nullable(),
        })
        .optional()
        .nullable(),
      ae_item_sku_info_dtos: z
        .object({ ae_item_sku_info_d_t_o: z.array(aeSkuSchema).default([]) })
        .optional()
        .nullable(),
      ae_item_properties: z
        .object({ ae_item_property: z.array(aePropertySchema).default([]) })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
});

// ===========================================================================
//  aliexpress.ds.freight.query
// ===========================================================================

export const aeDeliveryOptionSchema = z.object({
  /** رمز خدمة التسليم — يُمرَّر حرفيًا كـ logistics_service_name عند الطلب */
  code: z.string(),
  company: z.string().optional().nullable(),
  shipping_fee_cent: looseNumberOptional,
  shipping_fee_currency: z.string().optional().nullable(),
  shipping_fee_format: z.string().optional().nullable(),
  free_shipping: looseBooleanOptional,
  free_shipping_threshold: z.string().optional().nullable(),
  min_delivery_days: looseNumberOptional,
  max_delivery_days: looseNumberOptional,
  guaranteed_delivery_days: looseNumberOptional,
  estimated_delivery_time: z.string().optional().nullable(),
  delivery_date_desc: z.string().optional().nullable(),
  /** إن كانت false فلا يمكن تزويد العميل برقم تتبع */
  tracking: looseBooleanOptional,
  ship_from_country: z.string().optional().nullable(),
  available_stock: looseNumberOptional,
  /** هل السعر شامل ضريبة القيمة المضافة DDP */
  ddpIncludeVATTax: looseBooleanOptional,
  mayHavePFS: looseBooleanOptional,
});

export const aeFreightQueryResponseSchema = z.object({
  result: z
    .object({
      code: looseNumberOptional,
      msg: z.string().optional().nullable(),
      success: looseBooleanOptional,
      delivery_options: z.array(aeDeliveryOptionSchema).default([]),
    })
    .optional()
    .nullable(),
});

export type AeDeliveryOption = z.infer<typeof aeDeliveryOptionSchema>;

// ===========================================================================
//  aliexpress.ds.order.create
// ===========================================================================

export const aeOrderCreateResponseSchema = z.object({
  result: z
    .object({
      is_success: looseBooleanOptional,
      error_code: z.string().optional().nullable(),
      error_msg: z.string().optional().nullable(),
      /** ⚠️ مصفوفة — الطلبية الواحدة قد تنقسم على عدة بائعين */
      order_list: z
        .array(z.union([z.string(), z.number()]))
        .default([])
        .transform((arr) => arr.map(String)),
    })
    .optional()
    .nullable(),
});

// ===========================================================================
//  aliexpress.trade.ds.order.get
// ===========================================================================

const aeMoneySchema = z
  .object({
    amount: z.union([z.string(), z.number()]).optional().nullable(),
    currency_code: z.string().optional().nullable(),
  })
  .optional()
  .nullable();

export const aeOrderDetailResponseSchema = z.object({
  result: z
    .object({
      order_status: z.string().optional().nullable(),
      logistics_status: z.string().optional().nullable(),
      /** الثواني المتبقية حتى انتهاء مهلة الدفع */
      pay_timeout_second: looseNumberOptional,
      gmt_create: z.string().optional().nullable(),
      order_paidtime_string: z.string().optional().nullable(),
      order_amount: aeMoneySchema,
      user_order_amount: aeMoneySchema,
      child_order_list: z
        .array(
          z.object({
            sale_fee: aeMoneySchema,
            sale_discount_fee: aeMoneySchema,
            shipping_fee: aeMoneySchema,
            actual_shipping_fee: aeMoneySchema,
            actual_tax_fee: aeMoneySchema,
            actual_fee: aeMoneySchema,
            already_include_tax: z.string().optional().nullable(),
          }),
        )
        .default([]),
    })
    .optional()
    .nullable(),
});

// ===========================================================================
//  aliexpress.ds.order.tracking.get
// ===========================================================================

export const aeTrackingResponseSchema = z.object({
  result: z
    .object({
      ret: looseBooleanOptional,
      code: z.string().optional().nullable(),
      msg: z.string().optional().nullable(),
      data: z
        .object({
          tracking_detail_line_list: z
            .array(
              z.object({
                mail_no: z.string().optional().nullable(),
                carrier_name: z.string().optional().nullable(),
                cp_name: z.string().optional().nullable(),
                cp_website_url: z.string().optional().nullable(),
                eta_time_stamps: looseNumberOptional,
                detail_node_list: z
                  .array(
                    z.object({
                      tracking_name: z.string().optional().nullable(),
                      tracking_detail_desc: z.string().optional().nullable(),
                      time_stamp: looseNumberOptional,
                    }),
                  )
                  .default([]),
                package_item_list: z
                  .array(
                    z.object({
                      item_id: z.union([z.string(), z.number()]).optional().nullable(),
                      item_title: z.string().optional().nullable(),
                      sku_desc: z.string().optional().nullable(),
                      quantity: looseNumberOptional,
                    }),
                  )
                  .default([]),
              }),
            )
            .default([]),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
});

// ===========================================================================
//  aliexpress.ds.category.get
// ===========================================================================

export const aeCategoryResponseSchema = z.object({
  resp_result: z
    .object({
      resp_code: looseNumberOptional,
      resp_msg: z.string().optional().nullable(),
      result: z
        .object({
          categories: z
            .array(
              z.object({
                category_id: z.union([z.string(), z.number()]),
                category_name: z.string(),
                parent_category_id: z
                  .union([z.string(), z.number()])
                  .optional()
                  .nullable(),
              }),
            )
            .default([]),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
});
