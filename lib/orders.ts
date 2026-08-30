import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { AeApiError, placeOrder } from "@/lib/aliexpress";
import { buildCartSummary } from "@/lib/cart-service";
import type { Cart } from "@/lib/cart";
import type { ShippingAddress } from "@/lib/ksa";

/**
 * محرّك الطلبيات.
 *
 * المبدأ الحاكم: **لا يُستدعى ds.order.create إلا بمفتاح منع تكرار مثبَّت
 * مسبقًا في قاعدة بياناتنا**. فإذا انقطع الاتصال ولم نعرف مصير الطلبية،
 * أعدنا الإرسال بالقيمة نفسها فترفضها المنصة بـ REPEATED_ORDER_ERROR
 * بدل أن تشتري مرتين.
 */

/** رقم طلبية مقروء للعميل. */
function generateOrderNumber(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `AE-${ymd}-${rand}`;
}

export interface CreateOrderInput {
  cart: Cart;
  address: ShippingAddress;
  userId?: string;
  addressId?: string;
  notes?: string;
}

export interface CreateOrderResult {
  orderId: string;
  orderNumber: string;
}

/**
 * المرحلة الأولى: تثبيت الطلبية محليًا.
 * تُحسب المبالغ من بيانات حيّة، ويُثبَّت سعر الصرف، ويُولَّد outOrderId.
 * لا يُلمَس AliExpress هنا إطلاقًا.
 */
export async function createLocalOrder(
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  const summary = await buildCartSummary(input.cart);

  if (summary.lines.length === 0) {
    throw new Error("السلة فارغة");
  }
  if (summary.hasIssues) {
    throw new Error("توجد منتجات غير متاحة في السلة");
  }

  const orderNumber = generateOrderNumber();
  // مفتاح منع التكرار — يُولَّد مرة واحدة ولا يتغيّر مهما تكرّرت المحاولات
  const outOrderId = `${orderNumber}-${randomBytes(4).toString("hex")}`;

  const order = await prisma.order.create({
    data: {
      orderNumber,
      outOrderId,
      userId: input.userId ?? null,
      addressId: input.addressId ?? null,
      status: "PENDING_PAYMENT",
      shippingSnapshot: input.address as object,
      subtotalSar: summary.subtotalSar,
      shippingSar: summary.shippingSar,
      vatSar: summary.vatSar,
      totalSar: summary.totalSar,
      costSourceCurrency: env().AE_SOURCE_CURRENCY,
      costSubtotal: summary.costSubtotal,
      costShipping: summary.costShipping,
      fxRateUsed: summary.fxRate,
      notes: input.notes ?? null,
      items: {
        create: summary.lines.map((l) => ({
          aeProductId: l.aeProductId,
          skuAttr: l.skuAttr,
          titleSnapshot: l.title,
          imageSnapshot: l.imageUrl || null,
          variantLabel: l.variantLabel || null,
          quantity: l.quantity,
          unitPriceSar: l.unitPriceSar,
          unitCostSource: l.unitCostSource,
          logisticsServiceName: l.logisticsServiceName,
          shippingCompany: l.shippingCompany || null,
          minDeliveryDays: l.minDeliveryDays,
          maxDeliveryDays: l.maxDeliveryDays,
        })),
      },
    },
    select: { id: true, orderNumber: true },
  });

  return { orderId: order.id, orderNumber: order.orderNumber };
}

export type SourcingOutcome =
  | { ok: true; aeOrderIds: string[] }
  | { ok: false; errorCode: string; message: string; retryable: boolean };

/**
 * المرحلة الثانية: شراء الطلبية فعليًا من AliExpress.
 *
 * تُستدعى بعد تأكيد الدفع. مصمَّمة لتكون قابلة لإعادة الاستدعاء بأمان:
 * إن كانت الطلبية مصدَّرة مسبقًا تُعيد النتيجة المخزّنة دون استدعاء جديد.
 */
export async function sourceOrderFromAliExpress(
  orderId: string,
  opts: { tryToPay?: boolean } = {},
): Promise<SourcingOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, aeOrders: true },
  });

  if (!order) {
    return {
      ok: false,
      errorCode: "ORDER_NOT_FOUND",
      message: "الطلبية غير موجودة",
      retryable: false,
    };
  }

  // مصدَّرة مسبقًا — لا نستدعي المنصة مرة أخرى
  if (order.aeOrders.length > 0) {
    return { ok: true, aeOrderIds: order.aeOrders.map((a) => a.aeOrderId) };
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { status: "SOURCING" },
  });

  const addr = order.shippingSnapshot as unknown as ShippingAddress;

  try {
    const result = await placeOrder({
      outOrderId: order.outOrderId,
      orderId: order.id,
      tryToPay: opts.tryToPay ?? false,
      address: {
        country: addr.country,
        province: addr.province,
        city: addr.city,
        addressLine1: addr.addressLine1,
        addressLine2: addr.addressLine2 || undefined,
        postalCode: addr.postalCode || undefined,
        fullName: addr.fullName,
        phone: addr.phone,
        phoneCountry: "+966",
        // العنوان الوطني السعودي
        nationalAddress: addr.nationalAddress || undefined,
      },
      items: order.items.map((it) => ({
        aeProductId: it.aeProductId,
        skuAttr: it.skuAttr,
        quantity: it.quantity,
        logisticsServiceName: it.logisticsServiceName,
      })),
    });

    // order_list مصفوفة — قد تنقسم الطلبية على عدة بائعين
    await prisma.$transaction([
      prisma.aeOrder.createMany({
        data: result.aeOrderIds.map((aeOrderId) => ({
          orderId: order.id,
          aeOrderId,
        })),
        skipDuplicates: true,
      }),
      prisma.order.update({
        where: { id: order.id },
        data: { status: "SOURCED", placedAt: new Date() },
      }),
    ]);

    return { ok: true, aeOrderIds: result.aeOrderIds };
  } catch (e) {
    if (!(e instanceof AeApiError)) throw e;

    // الطلبية موجودة أصلًا على المنصة — نسجّلها بدل اعتبارها فشلًا
    if (e.code === "REPEATED_ORDER_ERROR") {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: "SOURCED", placedAt: new Date() },
      });
      return {
        ok: false,
        errorCode: e.code,
        message:
          "الطلبية مسجّلة مسبقًا لدى المورّد. لن يُخصم المبلغ مرتين — سيراجعها فريقنا.",
        retryable: false,
      };
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { status: "SOURCING_FAILED" },
    });

    return {
      ok: false,
      errorCode: e.code,
      message: e.customerMessage,
      // إعادة المحاولة الآلية مسموحة فقط للأخطاء المصنّفة كذلك
      retryable: e.isRetryable || e.needsRefresh,
    };
  }
}

/** تحديد الطلبية كمدفوعة (يستدعيه معالج الدفع بعد نجاح العملية). */
export async function markOrderPaid(orderId: string): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: { status: "PAID" },
  });
}
