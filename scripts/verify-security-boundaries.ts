import "dotenv/config";
import { getProduct, getShippingOptions, getTracking, searchProducts } from "@/lib/aliexpress/api";
import { AeApiError } from "@/lib/aliexpress/errors";
import {
  aeCategoryResponseSchema,
  aeTextSearchResponseSchema,
  aeTrackingResponseSchema,
} from "@/lib/aliexpress/schemas";
import { shippingAddressSchema } from "@/lib/ksa";
import { isOrderNumber } from "@/lib/order-number";
import { serializeTrackingNodes } from "@/lib/tracking";
import { cartSchema } from "@/lib/cart";
import { apiGet, ApiError } from "@/lib/query/fetcher";
import { sign, unsign } from "@/lib/signed-cookie";
import { safeErrorKind } from "@/lib/safe-log";

let passed = 0;

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`فشل: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function rejectsAsLocalInput(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    return error instanceof AeApiError && error.code === "INVALID_LOCAL_INPUT";
  }
}

async function main(): Promise<void> {
  console.log("\n=== تحقق حدود البيانات غير الموثوقة ===\n");

  check("رقم الطلب القانوني فقط يُقبل", isOrderNumber("AE-20260906-12ABEF"));
  check("المسار المشوّه يُرفض قبل قاعدة البيانات", !isOrderNumber("../AE-20260906-12ABEF"));

  const serialized = serializeTrackingNodes([
    { title: "  وصل\nللمدينة ", description: " جاهز\t", at: "2026-09-06T00:00:00Z" },
    { title: "bad", description: "bad", at: "not-a-date" },
    null,
  ]);
  check(
    "JSON التتبع التالف لا يرمي وتُزال محارف التحكم",
    serialized.length === 1 &&
      serialized[0].title === "وصل للمدينة" &&
      serialized[0].description === "جاهز",
  );

  const manyNodes = Array.from({ length: 700 }, (_, index) => ({
    title: `node-${index}`,
    description: "ok",
    at: "2026-09-06T00:00:00Z",
  }));
  check("قراءة عقد التتبع من DB محدودة بـ500", serializeTrackingNodes(manyNodes).length === 500);

  const oversizedTracking = {
    result: {
      data: {
        tracking_detail_line_list: Array.from({ length: 101 }, () => ({
          mail_no: "TRACK",
        })),
      },
    },
  };
  check(
    "استجابة المورد لا تقبل أكثر من 100 طرد",
    !aeTrackingResponseSchema.safeParse(oversizedTracking).success,
  );

  const oversizedSearch = {
    data: {
      products: Array.from({ length: 201 }, (_, index) => ({
        itemId: String(10_000 + index),
        title: "item",
      })),
    },
  };
  check(
    "استجابة البحث لا تقبل مصفوفة منتجات غير محدودة",
    !aeTextSearchResponseSchema.safeParse(oversizedSearch).success,
  );

  const oversizedCategories = {
    resp_result: {
      result: {
        categories: Array.from({ length: 1_001 }, (_, index) => ({
          category_id: index,
          category_name: "category",
        })),
      },
    },
  };
  check(
    "استجابة الفئات لا تقبل مصفوفة غير محدودة",
    !aeCategoryResponseSchema.safeParse(oversizedCategories).success,
  );
  check(
    "اسم الفئة القادم من المورد محدود الطول",
    !aeCategoryResponseSchema.safeParse({
      resp_result: {
        result: {
          categories: [{ category_id: 1, category_name: "x".repeat(501) }],
        },
      },
    }).success,
  );

  check(
    "عنوان الشحن يرفض محارف التحكم الداخلية",
    !shippingAddressSchema.safeParse({
      fullName: "عميل\nمزور",
      phone: "0512345678",
      country: "SA",
      province: "الرياض",
      city: "الرياض",
      addressLine1: "حي الندى شارع الملك",
      addressLine2: "",
      postalCode: "12345",
      nationalAddress: "RRDA2929",
    }).success,
  );

  const cartItem = {
    aeProductId: "1000000001",
    skuAttr: "1:1#safe",
    quantity: 1,
    logisticsServiceName: "SAFE_TRACKED",
  };
  check(
    "السلة لا تقبل أكثر من 10 أسطر حتى داخل حدود الخادم",
    !cartSchema.safeParse(Array.from({ length: 11 }, () => cartItem)).success,
  );

  const signedCookie = sign("boundary", "cart");
  check("الكوكي القانوني يُفك للغرض نفسه", unsign(signedCookie, "cart") === "boundary");
  check("التوقيع لا يُنقل بين أغراض الكوكيز", unsign(signedCookie, "guest-orders") === null);
  check("ترميز MAC غير المعياري يُرفض", unsign(`${signedCookie}!`, "cart") === null);
  const base64urlAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastMacCharacter = signedCookie.at(-1) ?? "";
  const lastMacIndex = base64urlAlphabet.indexOf(lastMacCharacter);
  const alternateLastCharacter =
    lastMacIndex >= 0
      ? base64urlAlphabet[(lastMacIndex & ~3) | ((lastMacIndex + 1) & 3)]
      : "";
  const nonCanonicalMac = `${signedCookie.slice(0, -1)}${alternateLastCharacter}`;
  check(
    "تمثيل base64url بديل لنفس MAC يُرفض",
    alternateLastCharacter !== lastMacCharacter &&
      unsign(nonCanonicalMac, "cart") === null,
  );
  check(
    "كوكي خام ضخم يُرفض قبل فك base64",
    unsign(`v1.${"A".repeat(5_000)}.${"A".repeat(43)}`, "cart") === null,
  );
  let oversizedSignRejected = false;
  try {
    sign("x".repeat(5_000), "cart");
  } catch (error) {
    oversizedSignRejected = error instanceof RangeError;
  }
  check("الخادم لا ينشئ كوكيًا أكبر من حد المتصفح", oversizedSignRejected);

  const forgedError = new Error("secret detail");
  forgedError.name = "ATTACKER_CONTROLLED_NAME";
  (forgedError as Error & { code?: string }).code = "ATTACKER_CODE";
  check(
    "بطاقة السجل لا تمرر اسم أو code يحدده مصدر خارجي",
    safeErrorKind(forgedError) === "Error",
  );

  check(
    "معرّف تتبع المورد يُرفض محليًا قبل الشبكة",
    await rejectsAsLocalInput(() => getTracking("../../secret")),
  );
  check(
    "كمية شحن غير معقولة تُرفض محليًا قبل الشبكة",
    await rejectsAsLocalInput(() =>
      getShippingOptions({ aeProductId: "1000000001", quantity: 10_000 }),
    ),
  );
  check(
    "اسم المحافظة ورمزها لا يُرسلان معًا إلى مزوّد الشحن",
    await rejectsAsLocalInput(() =>
      getShippingOptions({
        aeProductId: "1000000001",
        quantity: 1,
        province: "الرياض",
        provinceCode: "SA-01",
      }),
    ),
  );
  check(
    "وجهة شحن فارغة تُرفض محليًا قبل الشبكة",
    await rejectsAsLocalInput(() =>
      getShippingOptions({
        aeProductId: "1000000001",
        quantity: 1,
        province: "   ",
      }),
    ),
  );

  const clamped = await searchProducts({ page: -10, pageSize: 10_000 });
  check("دالة البحث نفسها تقيّد الصفحة والحجم", clamped.page === 1 && clamped.pageSize === 100);
  check(
    "كل بطاقة بحث لها سعر موجب وعملة المصدر",
    clamped.items.every(
      (item) => item.sourcePrice > 0 && item.currency === "USD",
    ),
  );

  check(
    "صور البحث الوهمية تبقى data URL كاملة بعد الفصل",
    clamped.items.every(
      (item) =>
        item.imageUrl.startsWith("data:image/svg+xml,") ||
        item.imageUrl.startsWith("https://"),
    ),
  );
  const mockProduct = await getProduct("1005006891234501");
  check(
    "تفاصيل المنتج تحمل صورًا كاملة ولا تحفظ HTML المورّد الخام",
    mockProduct.imageUrls.length >= 1 &&
      mockProduct.imageUrls.every((url) => url.startsWith("data:image/svg+xml,")) &&
      !mockProduct.descriptionText?.includes("<p>"),
  );

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
      })) as typeof fetch;
    let oversizedRejected = false;
    try {
      await apiGet("/synthetic-oversized-response");
    } catch (error) {
      oversizedRejected =
        error instanceof ApiError && error.code === "INVALID_RESPONSE";
    }
    check("عميل المتصفح يرفض JSON أكبر من 1MiB", oversizedRejected);

    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", {
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    let wrongTypeRejected = false;
    try {
      await apiGet("/synthetic-html-response");
    } catch (error) {
      wrongTypeRejected =
        error instanceof ApiError && error.code === "INVALID_RESPONSE";
    }
    check("عميل المتصفح يرفض استجابة ناجحة ليست JSON", wrongTypeRejected);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\nنجح تحقق الحدود: ${passed}/${passed}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "فشل تحقق الحدود");
  process.exitCode = 1;
});
