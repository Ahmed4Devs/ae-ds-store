"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, Field, Input } from "@/components/ui";
import { saudiPhoneSchema } from "@/lib/ksa";

/**
 * تعديل الاسم ورقم الجوال.
 *
 * ثلاثة فخاخ في better-auth تحكم شكل هذا النموذج:
 *  • عميل better-auth يختار POST أو GET حسب وجود مفاتيح في الجسم، فاستدعاء
 *    updateUser بكائن فارغ يتحوّل إلى GET ويردّ 404 — لذلك نبني فرقًا
 *    ونتجاهل الإرسال كليًا حين لا يتغيّر شيء.
 *  • الحقل role معرَّف بـ input:false، فتمرير كائن المستخدم كاملًا يردّ 400
 *    FIELD_NOT_ALLOWED — لا ننشر المستخدم، نرسل الحقول المتغيّرة وحدها.
 *  • البريد لا يتغيّر عبر هذه النقطة (EMAIL_CAN_NOT_BE_UPDATED) وتغييره
 *    يحتاج نقطة change-email غير المُفعَّلة هنا، فنعرضه معطّلًا.
 */

export interface ProfileFormLabels {
  title: string;
  name: string;
  phone: string;
  phoneHint: string;
  email: string;
  emailImmutable: string;
  saved: string;
  failed: string;
  save: string;
  saving: string;
  nameRequired: string;
}

export function ProfileForm({
  defaultName,
  defaultPhone,
  email,
  labels,
}: {
  defaultName: string;
  defaultPhone: string;
  email: string;
  labels: ProfileFormLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  /** الجوال محفوظ مطبَّعًا (5XXXXXXXX) ويُعرض بالصيغة المألوفة 05XXXXXXXX. */
  const phoneInitial = /^5\d{8}$/.test(defaultPhone)
    ? `0${defaultPhone}`
    : defaultPhone;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setNotice(null);

    const fd = new FormData(e.currentTarget);
    const name = String(fd.get("name") ?? "").trim();
    const rawPhone = String(fd.get("phone") ?? "").trim();

    const nextErrors: Record<string, string> = {};
    if (name.length < 2) nextErrors.name = labels.nameRequired;

    // فارغ = مسح الرقم، وغير ذلك يُطبَّع بنفس قواعد إتمام الشراء حتى لا
    // يُخزَّن الرقم بصيغتين مختلفتين في مكانين.
    let phone = "";
    if (rawPhone) {
      const parsed = saudiPhoneSchema.safeParse(rawPhone);
      // رسالة المخطّط عربية دائمًا، فنستخدم التلميح المترجَم بدلًا منها.
      if (!parsed.success) nextErrors.phone = labels.phoneHint;
      else phone = parsed.data;
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    // الفرق فقط: كائن فارغ يعني طلب GET فاشلًا، فنكتفي برسالة الحفظ.
    const diff: { name?: string; phone?: string } = {};
    if (name !== defaultName) diff.name = name;
    if (phone !== defaultPhone) diff.phone = phone;

    if (Object.keys(diff).length === 0) {
      setNotice({ ok: true, text: labels.saved });
      return;
    }

    startTransition(async () => {
      const res = await authClient.updateUser(diff);

      if (res.error) {
        setNotice({ ok: false, text: labels.failed });
        return;
      }

      // النقطة تردّ { status: true } لا المستخدم المحدَّث، والجلسة تُقرأ على
      // الخادم في هذا التطبيق — فالتحديث يظهر بإعادة قراءة الصفحة لا بقراءة الردّ.
      setNotice({ ok: true, text: labels.saved });
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="font-semibold">{labels.title}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={labels.name} required error={errors.name}>
          <Input
            name="name"
            defaultValue={defaultName}
            autoComplete="name"
            required
          />
        </Field>

        <Field label={labels.phone} error={errors.phone} hint={labels.phoneHint}>
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            dir="ltr"
            defaultValue={phoneInitial}
            autoComplete="tel"
            placeholder="05XXXXXXXX"
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label={labels.email} hint={labels.emailImmutable}>
            <Input
              value={email}
              dir="ltr"
              readOnly
              disabled
              className="opacity-60"
            />
          </Field>
        </div>
      </div>

      {notice && (
        <p
          className={
            "text-sm " +
            (notice.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400")
          }
        >
          {notice.text}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? labels.saving : labels.save}
      </Button>
    </form>
  );
}
