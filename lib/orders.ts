import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { AeApiError, orderAfterPay, placeOrder } from "@/lib/aliexpress";
import { buildCartSummary } from "@/lib/cart-service";
import type { Cart } from "@/lib/cart";
import type { ShippingAddress } from "@/lib/ksa";
import { dictionaries, DEFAULT_LOCALE, type Locale } from "@/lib/i18n/shared";

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
  locale?: Locale;
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
  const locale = input.locale ?? DEFAULT_LOCALE;
  const summary = await buildCartSummary(input.cart, locale);
  // القاموس يُختار من اللغة المُمرَّرة لا من الكوكيز: محرّك الطلبيات
  // يجب أن يعمل خارج نطاق الطلب أيضًا (المهام المجدولة وسكربتات التحقق).
  const t = dictionaries[locale];

  if (summary.lines.length === 0) {
    throw new Error(t.checkout.cartEmpty);
  }
  if (summary.hasIssues) {
    throw new Error(t.checkout.unavailableItems);
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

  // مصدَّرة مسبقًا — لا نستدعي المنصة مرة أخرى. ونصلح الحالة إن تخلّفت:
  // طلبية لها صفوف AeOrder لكنها ما زالت SOURCING/PAID (سقط الخادم بعد
  // الشراء وقبل كتابة SOURCED) تبقى خفيّة عن المزامنة وعن العميل — والكتابة
  // الشرطية لا تلمس المشحونة أو المسلَّمة أو الملغاة.
  if (order.aeOrders.length > 0) {
    await prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: ["PAID", "SOURCING", "SOURCING_FAILED"] },
      },
      data: { status: "SOURCED", placedAt: order.placedAt ?? new Date() },
    });
    return { ok: true, aeOrderIds: order.aeOrders.map((a) => a.aeOrderId) };
  }

  /**
   * بوابة الحالة + مزلاج التزامن في كتابة واحدة.
   *
   * الشراء يستهلك مالًا حقيقيًا، فيجب أن يحرسه شرطان: **مدفوعة** و**لا
   * يشتريها أحد الآن**. الكتابة الشرطية (PAID/SOURCING_FAILED → SOURCING)
   * تحقّقهما معًا: من ينجح في تغيير الحالة يملك حقّ الشراء وحده، ومن يجدها
   * قد صارت SOURCING (منافس سبقه) أو حالةً أخرى يتوقّف.
   *
   * كان الحارس السابق قراءةً ثم كتابةً غير مشروطة تضع SOURCING دائمًا، مع
   * إدراج SOURCING نفسها في القائمة المسموحة — فاستدعاءان متزامنان (نقر
   * مزدوج على «إعادة التوريد»، أو إشعار متأخّر يسابق زرًّا) كانا يمرّان
   * معًا فيشتريان الطلبية مرتين؛ لا يحمي منه إلا ارتداد REPEATED_ORDER_ERROR
   * وهو حارس أخير لا أول.
   */
  // نافذة اعتبار توريدٍ جارٍ ميتًا: placeOrder مهلته 20 ثانية، فحالة SOURCING
  // أقدم من دقيقتين تعني أن الاستدعاء السابق سقط قبل أن يكتب صفوف AeOrder،
  // فيجوز للمسؤول إعادة المحاولة. الحيّ (updatedAt حديث) يبقى محميًّا.
  const STALE_SOURCING_MS = 2 * 60 * 1000;
  const staleCutoff = new Date(Date.now() - STALE_SOURCING_MS);

  const claim = await prisma.order.updateMany({
    where: {
      id: orderId,
      OR: [
        { status: { in: ["PAID", "SOURCING_FAILED"] } },
        { status: "SOURCING", updatedAt: { lt: staleCutoff } },
      ],
    },
    data: { status: "SOURCING" },
  });

  if (claim.count === 0) {
    // لم نظفر بالحقّ: إمّا غير مدفوعة/ملغاة، أو يشتريها استدعاء آخر الآن.
    return {
      ok: false,
      errorCode:
        order.status === "SOURCING" ? "SOURCING_IN_PROGRESS" : "ORDER_NOT_PAID",
      message:
        order.status === "CANCELLED"
          ? "الطلبية ملغاة — لا تُشترى من المورّد."
          : order.status === "SOURCING"
            ? "التوريد جارٍ بالفعل لهذه الطلبية."
            : "الطلبية غير مدفوعة — لا تُشترى من المورّد قبل تأكيد الدفع.",
      retryable: false,
    };
  }

  const addr = order.shippingSnapshot as unknown as ShippingAddress;

  try {
    const result = await placeOrder({
      outOrderId: order.outOrderId,
      orderId: order.id,
      // الافتراضي من البيئة لا ثابتًا في الشيفرة: تفعيله يتطلّب حسابًا
      // مفوَّضًا كدروبشيبينغ، وينص التوثيق على أن تفعيله بغيره يُفشل الطلبية.
      tryToPay: opts.tryToPay ?? env().AE_TRY_TO_PAY,
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

    /**
     * الخصم لدى المنصة بعد الإنشاء.
     *
     * `orderAfterPay` كانت مكتوبةً ومختبرةً ولا يستدعيها شيء — وهي الخطوة
     * التي تُحوّل طلبية منشأة إلى طلبية مدفوعة لدى AliExpress. تُستدعى فقط
     * حين يُفعّل المشغّل `AE_TRY_TO_PAY` بعد تفويض الحساب كحساب دروبشيبينغ.
     *
     * فشلها لا يُفشل التوريد: الطلبية أُنشئت فعلًا على المنصة في الحالتين،
     * والدفع لها شأن منفصل يعيده المشغّل من لوحة المنصة. إسقاط التوريد
     * لأجله كان سيعلّم الطلبية فاشلةً وهي قائمة — ثم تُعاد محاولتها فترتد
     * بـ REPEATED_ORDER_ERROR.
     */
    if (opts.tryToPay ?? env().AE_TRY_TO_PAY) {
      for (const aeOrderId of result.aeOrderIds) {
        try {
          await orderAfterPay(aeOrderId);
        } catch (payErr) {
          console.error(
            `[orders] تعذّر الخصم لطلبية المنصة ${aeOrderId}:`,
            payErr,
          );
        }
      }
    }

    return { ok: true, aeOrderIds: result.aeOrderIds };
  } catch (e) {
    if (!(e instanceof AeApiError)) throw e;

    /**
     * الطلبية موجودة أصلًا على المنصة — نسجّلها بدل اعتبارها فشلًا.
     *
     * ⚠️ تنشأ هنا حالة تحتاج تدخّلًا بشريًا: نعرف أن الشراء وقع لكننا لا
     * نعرف معرّفات الطلبيات على المنصة، فلا صفوف AeOrder تُكتب. وأثرُ ذلك
     * أن حارس عدم التكرار أعلاه لا يعمل (كل إعادة محاولة تصطدم بالخطأ
     * نفسه إلى الأبد) وأن `syncActiveOrders` لا تراها أصلًا لأنها تستعلم
     * عبر جدول AeOrder. لذلك نثبّت السبب بوسم صريح ونضع الحالة
     * SOURCING_FAILED لا SOURCED: «تحتاج مراجعة» وصفٌ صادق لما جرى،
     * بينما SOURCED كانت تُخفي الطلبية عن لوحة المتابعة.
     */
    if (e.code === "REPEATED_ORDER_ERROR") {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: "SOURCING_FAILED",
          placedAt: order.placedAt ?? new Date(),
          // علَم مخصَّص لا تحميلٌ على cancelReason: الطلبية موجودة لدى
          // المورّد فلا يجوز للعميل إلغاؤها ذاتيًا كأنها لم تُشترَ، وهذا
          // العلَم هو ما يمنع ذلك ويستدعي المطابقة اليدوية.
          needsManualReview: true,
        },
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

/**
 * تحديد الطلبية كمدفوعة (يستدعيه معالج الدفع بعد نجاح العملية).
 *
 * كتابة **شرطية** لا مطلقة، وتعيد ما إذا طُبِّقت.
 *
 * السبب أن الدفع غير متزامن: الإشعار قد يصل متأخّرًا جدًا — بعد أن أُلغيت
 * الطلبية، أو بعد أن شُحنت وسُلّمت. والكتابة المطلقة كانت تُرجع الطلبية
 * إلى PAID في الحالتين، فتُخفي الإلغاء وتُعيد طلبيةً مسلَّمة إلى «قيد
 * التجهيز». الشرط يجعل الإشعار المتأخّر عمليةً بلا أثر.
 */
export async function markOrderPaid(orderId: string): Promise<boolean> {
  const res = await prisma.order.updateMany({
    where: { id: orderId, status: "PENDING_PAYMENT" },
    data: { status: "PAID" },
  });
  return res.count > 0;
}

/**
 * ما يجري بعد نجاح الدفع: تثبيت الحالة، ثم الشراء، ثم إشعار العميل.
 *
 * **لا ترمي أبدًا.** تُستدعى من مسار إشعار المزوّد، ورميُها هناك يعني
 * ردًّا غير 2xx فتعيد البوابة الإشعار مرارًا — ومع كل إعادة محاولةُ شراء
 * جديدة. الفشل يُسجَّل ويُترك للمراجعة اليدوية بدل أن يتحوّل إلى حلقة.
 */
export async function onPaymentSucceeded(orderId: string): Promise<void> {
  try {
    const applied = await markOrderPaid(orderId);

    if (!applied) {
      // ليست في انتظار الدفع: إمّا سُوّيت مسبقًا أو أُلغيت. لا نشتري.
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (order?.status !== "PAID") {
        console.error(
          `[orders] وصل تأكيد دفع لطلبية حالتها ${order?.status ?? "غير موجودة"} — لم يُشترَ شيء.`,
        );
        return;
      }
    }

    const outcome = await sourceOrderFromAliExpress(orderId);

    if (outcome.ok) {
      // الاستيراد ديناميكي: يبقى محرّك الطلبيات قابلًا للتحميل في
      // سكربتات لا تملك إعداد بريد (سكربتات التحقق والبذر).
      const { sendOrderPlacedMail } = await import("@/lib/mail");
      await sendOrderPlacedMail(orderId);
    } else {
      console.error(
        `[orders] فشل توريد الطلبية ${orderId} بعد الدفع: ${outcome.errorCode} — ${outcome.message}`,
      );
    }
  } catch (e) {
    console.error(`[orders] خطأ غير متوقّع بعد دفع الطلبية ${orderId}:`, e);
  }
}
