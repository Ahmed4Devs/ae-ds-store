"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { shippingAddressSchema } from "@/lib/ksa";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";

/**
 * إجراءات دفتر العناوين في حساب العميل.
 *
 * كل إجراء يقرأ الجلسة بنفسه ولا يثق بالصفحة التي استدعته: إجراءات الخادم
 * نقاط POST قابلة للاستدعاء مباشرة، فحارس الصفحة لا يحميها.
 *
 * والأهم: كل عملية كتابة أو حذف مقيَّدة بـ userId إلى جانب id. الاكتفاء بـ id
 * يفتح ثغرة IDOR — يكفي أن يخمّن مستخدم مسجَّل معرّف عنوان غيره ليعيد كتابته.
 */

export type AccountActionResult =
  | { ok: true }
  | { ok: false; errors?: Record<string, string>; message?: string };

/** ما يصل من النموذج قبل التطبيع — نصوص خام لا أكثر. */
export interface AddressInput {
  fullName: string;
  phone: string;
  province: string;
  city: string;
  addressLine1: string;
  addressLine2?: string;
  postalCode?: string;
  nationalAddress?: string;
}

const idSchema = z
  .object({ id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/) })
  .strict();

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  // P2034 = تعارض/تعطّل معاملة؛ P2002 قد يصدر من الفهرس الجزئي للعنوان
  // الافتراضي إذا وصلت عمليتا إنشاء متزامنتان قبل أن ترى إحداهما الأخرى.
  return error.code === "P2034" || error.code === "P2002";
}

async function serializable<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 10_000,
      });
    } catch (error) {
      if (attempt === 2 || !isRetryableTransactionError(error)) throw error;
    }
  }
  throw new Error("تعذّر إكمال المعاملة");
}

/** يحوّل أخطاء zod إلى خريطة حقل → رسالة، أول خطأ لكل حقل. */
function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return errors;
}

/** يبني حمولة Prisma من مخرجات المخطّط (الهاتف مطبَّع والرمز بأحرف كبيرة). */
function toAddressData(a: z.output<typeof shippingAddressSchema>) {
  return {
    fullName: a.fullName,
    phone: a.phone,
    country: a.country,
    province: a.province,
    city: a.city,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2 || null,
    postalCode: a.postalCode || null,
    nationalAddr: a.nationalAddress || null,
  };
}

export async function createAddressAction(
  input: AddressInput,
): Promise<AccountActionResult> {
  const [user, t] = await Promise.all([getCurrentUser(), getDictionary()]);
  if (!user) return { ok: false, message: t.admin.unauthorized };

  const parsed = shippingAddressSchema.safeParse({ ...input, country: "SA" });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };

  // أول عنوان يصبح الافتراضي تلقائيًا، وإلا بقي دفتر العناوين بلا افتراضي
  // فيفتح العميل صفحة الدفع بحقول فارغة رغم أن لديه عنوانًا محفوظًا.
  await serializable(async (tx) => {
    const existing = await tx.address.count({ where: { userId: user.id } });
    await tx.address.create({
      data: {
        userId: user.id,
        ...toAddressData(parsed.data),
        isDefault: existing === 0,
      },
    });
  });

  revalidatePath("/account");
  return { ok: true };
}

export async function updateAddressAction(
  input: AddressInput & { id: string },
): Promise<AccountActionResult> {
  const [user, t] = await Promise.all([getCurrentUser(), getDictionary()]);
  if (!user) return { ok: false, message: t.admin.unauthorized };

  const id = idSchema.safeParse({ id: input.id });
  if (!id.success) return { ok: false, message: t.account.addressFailed };

  const parsed = shippingAddressSchema.safeParse({ ...input, country: "SA" });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };

  // updateMany بشرط مركّب { id, userId } — التحديث بـ id وحده يسمح لأي
  // مستخدم مسجَّل بإعادة كتابة عنوان مستخدم آخر (IDOR).
  const res = await prisma.address.updateMany({
    where: { id: id.data.id, userId: user.id },
    data: toAddressData(parsed.data),
  });

  // صفر صفوف = العنوان غير موجود أو ليس لهذا المستخدم؛ نردّ الرسالة نفسها
  // في الحالتين حتى لا يصير الردّ كاشفًا لوجود المعرّف.
  if (res.count === 0) return { ok: false, message: t.account.addressFailed };

  revalidatePath("/account");
  return { ok: true };
}

export async function deleteAddressAction(
  input: { id: string },
): Promise<AccountActionResult> {
  const [user, t] = await Promise.all([getCurrentUser(), getDictionary()]);
  if (!user) return { ok: false, message: t.admin.unauthorized };

  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.account.addressFailed };

  // الحذف آمن على الطلبيات السابقة: العلاقة Order.addressId مضبوطة على
  // onDelete: SetNull، والطلبية تحتفظ بلقطة العنوان في shippingSnapshot
  // فتبقى الفاتورة وبيانات الشحن كما صدرت.
  const res = await prisma.address.deleteMany({
    where: { id: parsed.data.id, userId: user.id },
  });

  if (res.count === 0) return { ok: false, message: t.account.addressFailed };

  revalidatePath("/account");
  return { ok: true };
}

export async function setDefaultAddressAction(
  input: { id: string },
): Promise<AccountActionResult> {
  const [user, t] = await Promise.all([getCurrentUser(), getDictionary()]);
  if (!user) return { ok: false, message: t.admin.unauthorized };

  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.account.addressFailed };

  const owned = await prisma.address.findFirst({
    where: { id: parsed.data.id, userId: user.id },
    select: { id: true },
  });
  if (!owned) return { ok: false, message: t.account.addressFailed };

  // معاملة واحدة: لو نُفِّذت الخطوتان منفصلتين وفشلت الثانية لبقي المستخدم
  // بلا عنوان افتراضي إطلاقًا.
  await serializable(async (tx) => {
    await tx.address.updateMany({
      where: { userId: user.id, id: { not: owned.id } },
      data: { isDefault: false },
    });
    await tx.address.update({
      where: { id: owned.id },
      data: { isDefault: true },
    });
  });

  revalidatePath("/account");
  return { ok: true };
}
