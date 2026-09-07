import { NextResponse } from "next/server";
import { z } from "zod";
import { getShippingOptions, AeApiError } from "@/lib/aliexpress";
import { toSar } from "@/lib/pricing";
import { effectiveFxRateAsync } from "@/lib/fx";
import { deliveryEstimateAr } from "@/lib/ksa";
import { safeErrorKind } from "@/lib/safe-log";
import { getLocale } from "@/lib/i18n";
import type { ShippingOptionDto } from "@/lib/query/keys";

/**
 * خيارات الشحن لمنتج بكمية محددة.
 *
 * سبب وجود هذا المسار: أجرة الشحن تتغيّر بتغيّر الكمية، وكانت تُحسب
 * على الخادم لكمية واحدة فقط فيبقى السعر المعروض خاطئًا عند تغييرها.
 * الآن يعيد العميل الاستعلام عند كل تغيير.
 */

const querySchema = z.object({
  productId: z.string().regex(/^\d{5,32}$/),
  quantity: z
    .string()
    .regex(/^\d{1,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50)),
});

const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
} as const;

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  // ارفض المعاملات المكررة/المجهولة بدل اعتماد «الأول»؛ الوسطاء وذاكرات
  // التخزين قد يفسرون التكرار بطريقة أخرى، ما يصنع التباسًا في المدخلات.
  const keys = [...searchParams.keys()];
  const canonicalQuery =
    keys.every((key) => key === "productId" || key === "quantity") &&
    searchParams.getAll("productId").length === 1 &&
    searchParams.getAll("quantity").length === 1;

  const parsed = querySchema.safeParse({
    productId: searchParams.get("productId"),
    quantity: searchParams.get("quantity"),
  });

  if (!canonicalQuery || !parsed.success) {
    // لا نُفصح عن بنية التحقق الداخلية (مسارات الحقول ورموز zod) — إفشاء
    // معلومات لا حاجة للعميل به؛ رمز مقتضب يكفي.
    return NextResponse.json(
      { error: "INVALID_PARAMS" },
      { status: 400, headers: NO_STORE },
    );
  }

  const locale = await getLocale();

  try {
    // سعر الصرف من قاعدة البيانات لا قيمة البيئة — نفس ما تُحصّله السلة،
    // وإلا اختلفت أجرة الشحن المعروضة هنا عمّا يُدفع فعلًا.
    const [options, fxRate] = await Promise.all([
      getShippingOptions({
        aeProductId: parsed.data.productId,
        quantity: parsed.data.quantity,
      }),
      effectiveFxRateAsync(),
    ]);

    const dto: ShippingOptionDto[] = options.map((o) => ({
      code: o.code,
      company: o.company,
      feeSar: toSar(o.feeSource, fxRate),
      isFree: o.isFree,
      hasTracking: o.hasTracking,
      estimate: deliveryEstimateAr(o.minDays, o.maxDays, locale),
      minDays: o.minDays,
      maxDays: o.maxDays,
      availableStock: o.availableStock,
    }));

    return NextResponse.json(dto, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AeApiError) {
      // لا نعيد رمز المزوّد أو رسالته؛ كلاهما تفصيل داخلي لا يحتاجه العميل.
      const status = e.errorClass === "INVALID_INPUT" ? 400 : 502;
      return NextResponse.json(
        { error: status === 400 ? "INVALID_PARAMS" : "UPSTREAM_UNAVAILABLE" },
        { status, headers: NO_STORE },
      );
    }
    console.error(
      "[shipping] unexpected failure",
      safeErrorKind(e),
    );
    return NextResponse.json(
      { error: "INTERNAL_ERROR" },
      { status: 500, headers: NO_STORE },
    );
  }
}
