"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isAdmin } from "@/lib/session";
import { prisma } from "@/lib/db";
import { fetchAndMirrorProduct } from "@/lib/catalog";
import { AeApiError } from "@/lib/aliexpress";
import { getDictionary } from "@/lib/i18n";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * إجراءات الكتالوج المنسَّق.
 *
 * كل إجراء يتحقق من الصلاحية بنفسه — لا يُعتمد على حماية التخطيط وحدها،
 * لأن إجراءات الخادم قابلة للاستدعاء بطلب POST مباشر كما ينص توثيق
 * Next.js 16 صراحةً. وهنا تحديدًا الخطر ملموس: نشر منتج أو تغيير هامشه
 * يغيّر ما يراه كل زائر ويُسعَّر به.
 */

export type AdminCatalogResult = { ok: boolean; message: string };

const internalId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);

const publishSchema = z.object({
  productId: internalId,
  published: z.boolean(),
}).strict();

const marginSchema = z.object({
  productId: internalId,
  /** null يمسح التخصيص فيعود المنتج إلى الهامش الافتراضي */
  marginPercent: z.number().min(0).max(200).nullable(),
}).strict();

const importSchema = z.object({
  aeProductId: z.string().trim().regex(/^\d{5,32}$/),
}).strict();

/** يُعيد تحقّق الصفحات التي يظهر فيها أثر التعديل. */
function revalidateCatalog(): void {
  revalidatePath("/admin/products");
  revalidatePath("/collection");
}

export async function togglePublishAction(
  input: z.input<typeof publishSchema>,
): Promise<AdminCatalogResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: t.admin.invalidData };
  }

  // updateMany بدل update عمدًا: update يرمي P2025 على معرّف غير موجود،
  // فتصل للمستخدم رسالة Prisma بدل رسالة القاموس
  const res = await prisma.product.updateMany({
    where: { id: parsed.data.productId },
    data: { isPublished: parsed.data.published },
  });

  if (res.count === 0) {
    return { ok: false, message: t.admin.invalidData };
  }

  revalidateCatalog();
  return { ok: true, message: t.admin.publishToggled };
}

export async function setMarginAction(
  input: z.input<typeof marginSchema>,
): Promise<AdminCatalogResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const parsed = marginSchema.safeParse(input);
  if (!parsed.success) {
    // النطاق هو الفشل المتوقَّع هنا، ورسالته أوضح من «بيانات غير صالحة»
    return { ok: false, message: t.admin.marginInvalid };
  }

  const res = await prisma.product.updateMany({
    where: { id: parsed.data.productId },
    data: { marginPercent: parsed.data.marginPercent },
  });

  if (res.count === 0) {
    return { ok: false, message: t.admin.invalidData };
  }

  revalidateCatalog();
  return { ok: true, message: t.admin.marginSaved };
}

/**
 * يسحب منتجًا إلى المرآة المحلية بمعرّفه لدى AliExpress.
 *
 * يمرّ على نفس مسار المرآة الذي تستخدمه صفحة المنتج بدل كتابة صفوف يدويًا،
 * حتى لا يوجد طريقان لإنشاء منتج يختلفان في الحقول التي يملآنها.
 * والمنتج المستورد يبقى مخفيًا: الاستيراد إحضار لا نشر.
 */
export async function importProductAction(
  input: z.input<typeof importSchema>,
): Promise<AdminCatalogResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const parsed = importSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: t.admin.invalidData };
  }

  try {
    await fetchAndMirrorProduct(parsed.data.aeProductId);
  } catch (e) {
    // رسالة المشغّل لا رسالة العميل: هذه الشاشة إدارية والسبب الفني مفيد هنا
    const detail =
      e instanceof AeApiError ? `: ${e.operatorMessage}` : "";
    console.error("[admin] فشل استيراد منتج:", safeErrorKind(e));
    return { ok: false, message: `${t.admin.importFailed}${detail}` };
  }

  revalidateCatalog();
  return { ok: true, message: t.admin.imported };
}
