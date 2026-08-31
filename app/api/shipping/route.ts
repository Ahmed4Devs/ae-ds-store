import { NextResponse } from "next/server";
import { z } from "zod";
import { getShippingOptions, AeApiError } from "@/lib/aliexpress";
import { toSar } from "@/lib/pricing";
import { deliveryEstimateAr } from "@/lib/ksa";
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
  productId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(50),
});

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const parsed = querySchema.safeParse({
    productId: searchParams.get("productId"),
    quantity: searchParams.get("quantity"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_PARAMS", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const locale = await getLocale();

  try {
    const options = await getShippingOptions({
      aeProductId: parsed.data.productId,
      quantity: parsed.data.quantity,
    });

    const dto: ShippingOptionDto[] = options.map((o) => ({
      code: o.code,
      company: o.company,
      feeSar: toSar(o.feeSource),
      isFree: o.isFree,
      hasTracking: o.hasTracking,
      estimate: deliveryEstimateAr(o.minDays, o.maxDays, locale),
      minDays: o.minDays,
      maxDays: o.maxDays,
      availableStock: o.availableStock,
    }));

    return NextResponse.json(dto);
  } catch (e) {
    if (e instanceof AeApiError) {
      // أخطاء المدخلات تُعاد بـ 400 حتى لا تعيد المكتبة المحاولة عبثًا
      const status = e.errorClass === "INVALID_INPUT" ? 400 : 502;
      return NextResponse.json(
        { error: e.code, message: e.customerMessage },
        { status },
      );
    }
    throw e;
  }
}
