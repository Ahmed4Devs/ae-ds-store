"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isAdmin } from "@/lib/session";
import { FxRateRangeError, recordFxRate } from "@/lib/fx";
import { getDictionary } from "@/lib/i18n";

/**
 * إجراءات الإعدادات التشغيلية.
 *
 * التحقق من الصلاحية داخل الإجراء نفسه لا في التخطيط: سعر الصرف يضرب
 * كل سعر في المتجر، وإجراء الخادم يُستدعى بطلب POST مباشر لا يمرّ
 * بأي صفحة.
 */

export type AdminSettingsResult = { ok: boolean; message: string };

const fxSchema = z.object({
  rate: z.number(),
  source: z.string().trim().min(1).max(60).optional(),
});

export async function setFxRateAction(
  input: z.input<typeof fxSchema>,
): Promise<AdminSettingsResult> {
  const t = await getDictionary();

  if (!(await isAdmin())) {
    return { ok: false, message: t.admin.unauthorized };
  }

  const parsed = fxSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: t.admin.fxInvalid };
  }

  try {
    await recordFxRate(parsed.data.rate, parsed.data.source ?? "manual");
  } catch (e) {
    // يُفرَّق بين رفض النطاق وأي عطل آخر: الأول خطأ إدخال يصحّحه المستخدم،
    // والثاني عطل في النظام لا فائدة من إخبار المستخدم أن سعره «غير صالح» فيه
    if (e instanceof FxRateRangeError) {
      return { ok: false, message: t.admin.fxInvalid };
    }
    console.error("[admin] فشل حفظ سعر الصرف:", e);
    return { ok: false, message: t.common.unexpectedError };
  }

  revalidatePath("/admin/settings");
  // الأسعار المعروضة تُحسب من هذا السعر، فبقاؤها مخزّنة يعني عرض سعر قديم
  revalidatePath("/collection");

  return { ok: true, message: t.admin.fxSaved };
}
