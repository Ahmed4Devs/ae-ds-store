"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/components/ui";
import type { Dictionary } from "@/lib/i18n/shared";

/**
 * تعيين كلمة مرور جديدة برمز من البريد.
 */
export function ResetPasswordForm({
  token,
  labels,
}: {
  token: string;
  labels: Dictionary["auth"];
}) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  /**
   * يُقفل النموذج عند أول إرسال ولا يُفتح إلا عند خطأ تحقّق محليّ.
   *
   * السبب أن رمز الاستعادة **يُستهلك مرة واحدة**: ضغطتان سريعتان على
   * الزرّ تُنفقان الرمز في الطلب الأول ويرتدّ الثاني بأنه غير صالح، فيقرأ
   * المستخدم «انتهت صلاحية الرابط» بعد أن نجح تغييره فعلًا.
   */
  const [locked, setLocked] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const schema = z
    .object({
      // اثنا عشر محرفًا — مطابقًا لـ minPasswordLength على الخادم
      newPassword: z.string().min(12, labels.passwordPolicy),
      confirmPassword: z.string(),
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      path: ["confirmPassword"],
      message: labels.passwordsMismatch,
    });

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setErrors({});
    setFormError(null);

    const fd = new FormData(e.currentTarget);
    const parsed = schema.safeParse({
      newPassword: String(fd.get("newPassword") ?? ""),
      confirmPassword: String(fd.get("confirmPassword") ?? ""),
    });

    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        const k = String(i.path[0] ?? "form");
        errs[k] ??= i.message;
      }
      setErrors(errs);
      return;
    }

    setLocked(true);
    startTransition(async () => {
      const res = await authClient.resetPassword({
        newPassword: parsed.data.newPassword,
        token,
      });

      if (res.error) {
        setFormError(labels.resetInvalidBody);
        return;
      }

      setDone(true);
    });
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title={labels.resetDoneTitle}>
          <p>{labels.resetDoneBody}</p>
        </Alert>
        <Link
          href="/login"
          className="block text-center text-sm font-medium text-brand-600 hover:underline"
        >
          {labels.signIn}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field
        label={labels.newPassword}
        required
        error={errors.newPassword}
        hint={labels.passwordPolicy}
      >
        <Input
          name="newPassword"
          type="password"
          dir="ltr"
          autoComplete="new-password"
        />
      </Field>

      <Field
        label={labels.confirmPassword}
        required
        error={errors.confirmPassword}
      >
        <Input
          name="confirmPassword"
          type="password"
          dir="ltr"
          autoComplete="new-password"
        />
      </Field>

      {formError && (
        <div className="space-y-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <p>{formError}</p>
          <Link
            href="/forgot-password"
            className="block font-medium underline underline-offset-2"
          >
            {labels.resetRequestNew}
          </Link>
        </div>
      )}

      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={pending || locked}
      >
        {pending ? labels.processing : labels.resetCta}
      </Button>
    </form>
  );
}
