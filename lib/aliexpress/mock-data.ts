/**
 * بيانات وهمية مطابقة لبنية استجابات التوثيق الرسمي.
 *
 * الهدف ليس التجميل بل الأمانة البنيوية: كل استجابة هنا تحاكي الصيغة
 * الفعلية التي تعيدها المنصة — بما في ذلك عادتها في إرجاع الأرقام
 * والقيم المنطقية كسلاسل نصية — حتى لا يفاجئك التبديل إلى AE_MODE=live.
 */

const CATALOG_SEED = [
  {
    itemId: "1005006891234501",
    title: "Wireless Bluetooth Earbuds Pro — Noise Cancelling, 40H Playtime",
    titleAr: "سماعات بلوتوث لاسلكية Pro — عزل ضوضاء، تشغيل 40 ساعة",
    price: 12.86,
    original: 28.5,
    cateId: "70804",
    orders: "8432",
    rating: "4.7",
    image: "earbuds",
    variants: [
      { attr: "14:29#Black", label: "أسود", stock: 420, delta: 0 },
      { attr: "14:350850#White", label: "أبيض", stock: 260, delta: 0.4 },
      { attr: "14:193#Navy", label: "كحلي", stock: 95, delta: 0.8 },
    ],
  },
  {
    itemId: "1005006891234502",
    title: "Smart Watch Ultra 2 — AMOLED, IP68, Heart Rate & SpO2",
    titleAr: "ساعة ذكية Ultra 2 — شاشة AMOLED، مقاومة IP68، قياس النبض والأكسجين",
    price: 23.4,
    original: 55.0,
    cateId: "1511",
    orders: "15230",
    rating: "4.6",
    image: "watch",
    variants: [
      { attr: "14:29#Black;5:361386#42mm", label: "أسود · 42 مم", stock: 310, delta: 0 },
      { attr: "14:29#Black;5:100014064#46mm", label: "أسود · 46 مم", stock: 180, delta: 2.1 },
      { attr: "14:771#Silver;5:361386#42mm", label: "فضي · 42 مم", stock: 74, delta: 1.3 },
    ],
  },
  {
    itemId: "1005006891234503",
    title: "USB-C 65W GaN Fast Charger — 3 Ports, Foldable Plug",
    titleAr: "شاحن سريع USB-C بقوة 65 واط بتقنية GaN — 3 منافذ، قابس قابل للطي",
    price: 8.92,
    original: 19.9,
    cateId: "70801",
    orders: "23140",
    rating: "4.8",
    image: "charger",
    variants: [
      { attr: "14:29#Black;200007763#EU", label: "أسود · قابس أوروبي", stock: 640, delta: 0 },
      { attr: "14:29#Black;200007764#UK", label: "أسود · قابس بريطاني", stock: 210, delta: 0.25 },
    ],
  },
  {
    itemId: "1005006891234504",
    title: "Portable Blender 380ml — USB Rechargeable, 6 Blades",
    titleAr: "خلاط محمول 380 مل — شحن USB، ست شفرات",
    price: 15.75,
    original: 34.0,
    cateId: "1503",
    orders: "5120",
    rating: "4.5",
    image: "blender",
    variants: [
      { attr: "14:200004890#Green", label: "أخضر", stock: 130, delta: 0 },
      { attr: "14:350850#White", label: "أبيض", stock: 88, delta: 0 },
    ],
  },
  {
    itemId: "1005006891234505",
    title: "Car Phone Holder Magnetic — 360° Rotation, Vent Mount",
    titleAr: "حامل جوال مغناطيسي للسيارة — دوران 360 درجة، تثبيت على الفتحة",
    price: 4.35,
    original: 11.2,
    cateId: "34",
    orders: "41890",
    rating: "4.4",
    image: "holder",
    variants: [{ attr: "14:29#Black", label: "أسود", stock: 980, delta: 0 }],
  },
  {
    itemId: "1005006891234506",
    title: "LED Strip Lights 5M RGB — App Control, Music Sync",
    titleAr: "شريط إضاءة LED بطول 5 أمتار RGB — تحكم بالتطبيق ومزامنة مع الموسيقى",
    price: 9.6,
    original: 22.0,
    cateId: "39",
    orders: "18760",
    rating: "4.6",
    image: "ledstrip",
    variants: [
      { attr: "5:361386#5M", label: "5 أمتار", stock: 520, delta: 0 },
      { attr: "5:100014064#10M", label: "10 أمتار", stock: 240, delta: 4.2 },
    ],
  },
  {
    itemId: "1005006891234507",
    title: "Mechanical Keyboard 61 Keys RGB — Hot Swappable Switches",
    titleAr: "لوحة مفاتيح ميكانيكية 61 مفتاحًا RGB — مفاتيح قابلة للتبديل السريع",
    price: 28.9,
    original: 62.0,
    cateId: "70802",
    orders: "3410",
    rating: "4.7",
    image: "keyboard",
    variants: [
      { attr: "14:29#Black;200000124#Red", label: "أسود · مفاتيح حمراء", stock: 145, delta: 0 },
      { attr: "14:29#Black;200000125#Brown", label: "أسود · مفاتيح بنية", stock: 92, delta: 1.5 },
    ],
  },
  {
    itemId: "1005006891234508",
    title: "Insulated Water Bottle 750ml — Stainless Steel, 24H Cold",
    titleAr: "زجاجة ماء معزولة 750 مل — ستانلس ستيل، تحافظ على البرودة 24 ساعة",
    price: 11.2,
    original: 25.5,
    cateId: "1501",
    orders: "9870",
    rating: "4.8",
    image: "bottle",
    variants: [
      { attr: "14:29#Black", label: "أسود", stock: 310, delta: 0 },
      { attr: "14:771#Silver", label: "فضي", stock: 205, delta: 0 },
    ],
  },
];

const CATEGORY_NAMES: Record<string, string> = {
  "70804": "سماعات وصوتيات",
  "1511": "ساعات ذكية",
  "70801": "شواحن وكوابل",
  "1503": "أجهزة مطبخ",
  "34": "إكسسوارات سيارات",
  "39": "إضاءة",
  "70802": "ملحقات حاسب",
  "1501": "أدوات منزلية",
};

/** صورة SVG مضمّنة — تتجنّب الاعتماد على خدمات خارجية في وضع المحاكاة. */
function placeholderImage(key: string, label: string): string {
  const palette: Record<string, [string, string]> = {
    earbuds: ["#1e293b", "#38bdf8"],
    watch: ["#0f172a", "#a78bfa"],
    charger: ["#134e4a", "#2dd4bf"],
    blender: ["#14532d", "#4ade80"],
    holder: ["#1c1917", "#fbbf24"],
    ledstrip: ["#4c1d95", "#f472b6"],
    keyboard: ["#111827", "#60a5fa"],
    bottle: ["#0c4a6e", "#7dd3fc"],
  };
  const [bg, fg] = palette[key] ?? ["#1e293b", "#94a3b8"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="${fg}"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="250" r="110" fill="rgba(255,255,255,.14)"/><text x="300" y="470" font-family="system-ui,sans-serif" font-size="34" fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text></svg>`;
  // image_urls في استجابة AliExpress سلسلة مفصولة بفواصل منقوطة. وضع
  // `;utf8` داخل كل data URL يجعل محلّل الواجهة يقسم الصورة نفسها نصفين.
  // ترميز SVG نسبيًا لا يحتاج هذا الوسيط؛ الصيغة ذات الفاصلة وحدها صحيحة.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

type Seed = (typeof CATALOG_SEED)[number];

function findSeed(productId: string): Seed | undefined {
  return CATALOG_SEED.find((p) => p.itemId === String(productId));
}

// ===========================================================================
//  بناء الاستجابات الوهمية
// ===========================================================================

function mockTextSearch(params: Record<string, unknown>) {
  const keyword = String(params.keyWord ?? "").trim().toLowerCase();
  const categoryId = params.categoryId ? String(params.categoryId) : null;
  const pageSize = Number(params.pageSize ?? 20);
  const pageIndex = Number(params.pageIndex ?? 1);

  let items = CATALOG_SEED;
  if (categoryId) items = items.filter((p) => p.cateId === categoryId);
  if (keyword) {
    items = items.filter(
      (p) =>
        p.title.toLowerCase().includes(keyword) ||
        p.titleAr.includes(keyword) ||
        (CATEGORY_NAMES[p.cateId] ?? "").includes(keyword),
    );
  }

  const sortBy = String(params.sortBy ?? "");
  if (sortBy.startsWith("min_price")) {
    items = [...items].sort((a, b) =>
      sortBy.endsWith("desc") ? b.price - a.price : a.price - b.price,
    );
  } else if (sortBy.startsWith("orders")) {
    items = [...items].sort((a, b) =>
      sortBy.endsWith("asc")
        ? Number(a.orders) - Number(b.orders)
        : Number(b.orders) - Number(a.orders),
    );
  }

  const total = items.length;
  const start = (pageIndex - 1) * pageSize;
  const page = items.slice(start, start + pageSize);

  return {
    code: "0",
    msg: "success",
    data: {
      totalCount: String(total),
      pageIndex: String(pageIndex),
      pageSize: String(pageSize),
      products: page.map((p) => ({
        itemId: p.itemId,
        title: p.title,
        itemMainPic: placeholderImage(p.image, p.titleAr.slice(0, 24)),
        itemUrl: `https://www.aliexpress.com/item/${p.itemId}.html`,
        salePrice: String(p.price),
        salePriceCurrency: "USD",
        originalPrice: String(p.original),
        originalPriceCurrency: "USD",
        targetSalePrice: String(p.price),
        targetOriginalPrice: String(p.original),
        discount: `${Math.round((1 - p.price / p.original) * 100)}%`,
        orders: p.orders,
        score: p.rating,
        evaluateRate: `${Math.round(Number(p.rating) * 20)}%`,
        cateId: p.cateId,
        productVideoUrl: "",
        type: "search",
      })),
    },
  };
}

function mockProductGet(params: Record<string, unknown>) {
  const seed = findSeed(String(params.product_id ?? ""));
  if (!seed) {
    return { result: null, rsp_code: "404", rsp_msg: "ITEM_ID_NOT_FOUND", code: "ITEM_ID_NOT_FOUND" };
  }

  const images = [
    placeholderImage(seed.image, seed.titleAr.slice(0, 24)),
    placeholderImage(seed.image, "عرض جانبي"),
    placeholderImage(seed.image, "داخل العلبة"),
  ];

  return {
    rsp_code: "200",
    rsp_msg: "success",
    result: {
      ae_item_base_info_dto: {
        product_id: seed.itemId,
        subject: seed.title,
        detail: `<p>${seed.title}</p>`,
        category_id: seed.cateId,
        currency_code: "USD",
        product_status_type: "onSelling",
        evaluation_count: seed.orders,
        avg_evaluation_rating: seed.rating,
        sales_count: seed.orders,
      },
      ae_multimedia_info_dto: {
        image_urls: images.join(";"),
      },
      ae_item_sku_info_dtos: {
        ae_item_sku_info_d_t_o: seed.variants.map((v, i) => ({
          sku_id: `12000${seed.itemId.slice(-6)}${i}`,
          sku_attr: v.attr,
          sku_price: String((seed.original + v.delta).toFixed(2)),
          offer_sale_price: String((seed.price + v.delta).toFixed(2)),
          offer_bulk_sale_price: String((seed.price + v.delta - 0.5).toFixed(2)),
          sku_bulk_order: "3",
          sku_available_stock: String(v.stock),
          currency_code: "USD",
          sku_image: placeholderImage(seed.image, v.label),
          ae_sku_property_dtos: {
            ae_sku_property_d_t_o: [
              {
                sku_property_id: 14,
                sku_property_name: "الخيار",
                sku_property_value: v.label,
                property_value_definition_name: v.label,
                sku_image: placeholderImage(seed.image, v.label),
              },
            ],
          },
        })),
      },
      ae_item_properties: {
        ae_item_property: [
          { attr_name: "العلامة التجارية", attr_value: "OEM", attr_name_id: 2, attr_value_id: 200 },
          { attr_name: "بلد المنشأ", attr_value: "الصين", attr_name_id: 219, attr_value_id: 901 },
          { attr_name: "الضمان", attr_value: "12 شهرًا", attr_name_id: 330, attr_value_id: 12 },
        ],
      },
    },
  };
}

function mockFreightQuery(params: Record<string, unknown>) {
  const req = (params.queryDeliveryReq ?? {}) as Record<string, unknown>;
  const parsed =
    typeof req === "string" ? (JSON.parse(req) as Record<string, unknown>) : req;
  const seed = findSeed(String(parsed.productId ?? ""));
  const qty = Number(parsed.quantity ?? 1);

  if (!seed) {
    return { result: { code: "400", msg: "DELIVERY_INFO_EMPTY", success: "false", delivery_options: [] }, code: "DELIVERY_INFO_EMPTY" };
  }

  const base = 1.99 + qty * 0.35;
  return {
    result: {
      msg: "Call succeeds",
      code: "200",
      success: "true",
      delivery_options: [
        {
          code: "CAINIAO_FULFILLMENT_STD",
          company: "AliExpress Selection Standard",
          shipping_fee_cent: base.toFixed(2),
          shipping_fee_currency: "USD",
          shipping_fee_format: `US $${base.toFixed(2)}`,
          free_shipping: "false",
          free_shipping_threshold: "$10.00",
          min_delivery_days: "18",
          max_delivery_days: "32",
          guaranteed_delivery_days: "40",
          tracking: "true",
          ship_from_country: "CN",
          available_stock: "100",
          ddpIncludeVATTax: "true",
          mayHavePFS: "false",
          estimated_delivery_time: "",
          delivery_date_desc: "",
        },
        {
          code: "AE_CAINIAO_PREMIUM",
          company: "AliExpress Premium Shipping",
          shipping_fee_cent: (base + 4.5).toFixed(2),
          shipping_fee_currency: "USD",
          shipping_fee_format: `US $${(base + 4.5).toFixed(2)}`,
          free_shipping: "false",
          free_shipping_threshold: "$30.00",
          min_delivery_days: "8",
          max_delivery_days: "15",
          guaranteed_delivery_days: "20",
          tracking: "true",
          ship_from_country: "CN",
          available_stock: "100",
          ddpIncludeVATTax: "true",
          mayHavePFS: "false",
          estimated_delivery_time: "",
          delivery_date_desc: "",
        },
        {
          code: "EPAM_ECONOMY",
          company: "Economy Shipping",
          shipping_fee_cent: "0.00",
          shipping_fee_currency: "USD",
          shipping_fee_format: "Free",
          free_shipping: "true",
          free_shipping_threshold: "$0.00",
          min_delivery_days: "30",
          max_delivery_days: "55",
          guaranteed_delivery_days: "60",
          // خيار بلا تتبع — موجود عمدًا لاختبار منطق الاستبعاد
          tracking: "false",
          ship_from_country: "CN",
          available_stock: "100",
          ddpIncludeVATTax: "false",
          mayHavePFS: "true",
          estimated_delivery_time: "",
          delivery_date_desc: "",
        },
      ],
    },
    code: "0",
  };
}

/** ذاكرة الطلبيات الوهمية — تحاكي حالة الخادم بين الاستدعاءات. */
const mockOrders = new Map<
  string,
  { outOrderId: string; createdAt: number; status: string }
>();
const outOrderIndex = new Map<string, string[]>();

function mockOrderCreate(params: Record<string, unknown>) {
  const raw = params.param_place_order_request4_open_api_d_t_o;
  const dto = (
    typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})
  ) as Record<string, unknown>;

  const outOrderId = String(dto.out_order_id ?? "");
  const items = (dto.product_items ?? []) as Array<Record<string, unknown>>;
  const address = (dto.logistics_address ?? {}) as Record<string, unknown>;

  // تحقّق مطابق لسلوك المنصة الموثّق
  if (!address.country || !address.address || !address.city || !address.province) {
    return {
      result: {
        is_success: "false",
        error_code: "B_DROPSHIPPER_DELIVERY_ADDRESS_VALIDATE_FAIL",
        error_msg: "عنوان ناقص",
        order_list: [],
      },
    };
  }

  if (items.length === 0) {
    return {
      result: {
        is_success: "false",
        error_code: "ERROR_WHEN_BUILD_FOR_PLACE_ORDER",
        error_msg: "لا توجد عناصر",
        order_list: [],
      },
    };
  }

  // منع التكرار — نفس سلوك REPEATED_ORDER_ERROR الموثّق
  if (outOrderId && outOrderIndex.has(outOrderId)) {
    return {
      result: {
        is_success: "false",
        error_code: "REPEATED_ORDER_ERROR",
        error_msg: "طلبية مكرّرة",
        order_list: outOrderIndex.get(outOrderId) ?? [],
      },
    };
  }

  for (const it of items) {
    if (!it.logistics_service_name) {
      return {
        result: {
          is_success: "false",
          error_code: "DELIVERY_METHOD_NOT_EXIST",
          error_msg: "رمز خدمة الشحن مفقود",
          order_list: [],
        },
      };
    }
    if (!it.sku_attr) {
      return {
        result: {
          is_success: "false",
          error_code: "ERROR_WHEN_BUILD_FOR_PLACE_ORDER",
          error_msg: "sku_attr مفقود",
          order_list: [],
        },
      };
    }
  }

  // تقسيم على بائعين: عنصران فأكثر ⇒ طلبيتان — يحاكي كون order_list مصفوفة
  const chunks = items.length >= 2 ? 2 : 1;
  const orderIds: string[] = [];
  for (let i = 0; i < chunks; i++) {
    const id = `80${Date.now().toString().slice(-11)}${i}`;
    orderIds.push(id);
    mockOrders.set(id, {
      outOrderId,
      createdAt: Date.now(),
      status: "PLACE_ORDER_SUCCESS",
    });
  }
  if (outOrderId) outOrderIndex.set(outOrderId, orderIds);

  return {
    result: {
      is_success: "true",
      error_code: "",
      error_msg: "",
      order_list: orderIds,
    },
  };
}

function mockOrderDetail(params: Record<string, unknown>) {
  const raw = params.single_order_query;
  const q = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<
    string,
    unknown
  >;
  const id = String(q.order_id ?? "");
  const rec = mockOrders.get(id);

  const ageMin = rec ? (Date.now() - rec.createdAt) / 60000 : 0;
  const status =
    ageMin > 3 ? "WAIT_BUYER_ACCEPT_GOODS" : ageMin > 1 ? "WAIT_SELLER_SEND_GOODS" : "PLACE_ORDER_SUCCESS";
  const logistics =
    ageMin > 3 ? "SELLER_SEND_GOODS" : "NO_LOGISTICS";

  return {
    result: {
      order_status: status,
      logistics_status: logistics,
      pay_timeout_second: String(Math.max(0, Math.round(1200 - ageMin * 60))),
      gmt_create: new Date(rec?.createdAt ?? Date.now()).toISOString(),
      order_paidtime_string: new Date(rec?.createdAt ?? Date.now()).toISOString(),
      order_amount: { amount: "42.30", currency_code: "USD" },
      user_order_amount: { amount: "42.30", currency_code: "USD" },
      child_order_list: [
        {
          sale_fee: { amount: "38.60", currency_code: "USD" },
          sale_discount_fee: { amount: "0.00", currency_code: "USD" },
          shipping_fee: { amount: "3.70", currency_code: "USD" },
          actual_shipping_fee: { amount: "3.70", currency_code: "USD" },
          actual_tax_fee: { amount: "0.00", currency_code: "USD" },
          actual_fee: { amount: "42.30", currency_code: "USD" },
          already_include_tax: "true",
        },
      ],
    },
  };
}

function mockTracking(params: Record<string, unknown>) {
  const id = String(params.ae_order_id ?? "");
  const rec = mockOrders.get(id);
  const ageMin = rec ? (Date.now() - rec.createdAt) / 60000 : 999;

  // قبل شحن البائع لا توجد بيانات تتبع — سلوك موثّق وطبيعي
  if (ageMin < 3) {
    return {
      result: {
        ret: "false",
        code: "TRACKING DATA NOT FOUND",
        msg: "لم تُشحن بعد",
        data: { tracking_detail_line_list: [] },
      },
    };
  }

  const now = Date.now();
  const node = (name: string, desc: string, minsAgo: number) => ({
    tracking_name: name,
    tracking_detail_desc: desc,
    time_stamp: String(now - minsAgo * 60000),
  });

  return {
    result: {
      ret: "true",
      code: "200",
      msg: "success",
      data: {
        tracking_detail_line_list: [
          {
            mail_no: `LP${id.slice(-12)}CN`,
            carrier_name: "Cainiao",
            cp_name: "Cainiao Super Economy",
            cp_website_url: "https://global.cainiao.com/",
            eta_time_stamps: String(now + 14 * 86400000),
            detail_node_list: [
              node("تم استلام الطلب", "استلم البائع الطلبية وبدأ التجهيز", 180),
              node("غادر مركز الفرز", "غادرت الشحنة مركز الفرز في قوانغتشو", 120),
              node("في الطريق دوليًا", "الشحنة على متن رحلة دولية", 60),
            ],
            package_item_list: [
              {
                item_id: "1005006891234501",
                item_title: "Wireless Bluetooth Earbuds Pro",
                sku_desc: "أسود",
                quantity: "1",
              },
            ],
          },
        ],
      },
    },
  };
}

function mockCategoryGet() {
  return {
    resp_result: {
      resp_code: "200",
      resp_msg: "success",
      result: {
        categories: Object.entries(CATEGORY_NAMES).map(([id, name]) => ({
          category_id: id,
          category_name: name,
        })),
      },
    },
  };
}

function mockMemberBenefit() {
  return {
    rsp_code: "200",
    rsp_msg: "success",
    result: [
      { code: "DS_FREE_SHIPPING", title: "شحن مجاني لأعضاء الدروبشيبينغ", canApply: "true", canBenefit: "false" },
      { code: "DS_EXTRA_DISCOUNT", title: "خصم إضافي على الطلبيات", canApply: "true", canBenefit: "true" },
    ],
  };
}

// ===========================================================================

const HANDLERS: Record<string, (p: Record<string, unknown>) => unknown> = {
  "aliexpress.ds.text.search": mockTextSearch,
  "aliexpress.ds.product.get": mockProductGet,
  "aliexpress.ds.freight.query": mockFreightQuery,
  "aliexpress.ds.order.create": mockOrderCreate,
  "aliexpress.trade.ds.order.get": mockOrderDetail,
  "aliexpress.ds.order.tracking.get": mockTracking,
  "aliexpress.ds.category.get": mockCategoryGet,
  "aliexpress.ds.member.benefit.get": mockMemberBenefit,
  "aliexpress.ds.order.afterpay": () => ({
    rsp_code: "200",
    rsp_msg: "success",
    result: "true",
  }),

  /**
   * تجديد الرمز — المستند 834.
   *
   * موجود في المحاكاة حتى يسلك مسارُ التجديد الطريقَ نفسه في الوضعين، فلا
   * يكون أول اختبار حقيقي له هو لحظة انتهاء الرمز في الإنتاج.
   */
  "/auth/token/refresh": (p) => {
    const presented = String(p.refresh_token ?? "");
    if (!presented) {
      return {
        error_response: {
          code: "IllegalRefreshToken",
          msg: "refresh_token مطلوب",
        },
      };
    }
    const now = Date.now();
    return {
      access_token: `mock-access-${presented.slice(-6)}`,
      refresh_token: presented,
      expires_in: 86400,
      refresh_expires_in: 2592000,
      expire_time: now + 86400 * 1000,
      refresh_token_valid_time: now + 2592000 * 1000,
      account_platform: "buyer",
      account: "mock@example.com",
    };
  },
};

/** تأخير بسيط يحاكي زمن الشبكة حتى تظهر حالات التحميل في الواجهة. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getMockResponse<T>(
  apiName: string,
  params: Record<string, unknown>,
): Promise<T> {
  await delay(60 + Math.random() * 140);
  const handler = HANDLERS[apiName];
  if (!handler) {
    return {
      error_response: {
        code: "UnsupportedParamMapping",
        msg: `لا توجد محاكاة للواجهة ${apiName}`,
      },
    } as T;
  }
  return handler(params) as T;
}

/** الكتالوج الوهمي — تستخدمه سكربتات البذر. */
export const MOCK_CATALOG = CATALOG_SEED;
export const MOCK_CATEGORIES = CATEGORY_NAMES;
export { placeholderImage };
