"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, Field, Input } from "@/components/ui";

/**
 * تغيير كلمة المرور من داخل الحساب.
 *
 * الحدّ الأدنى اثنا عشر محرفًا مضبوط على الخادم (minPasswordLength)، وما هنا
 * فحص مسبق يوفّر رحلة إلى الخادم لا أكثر.
 *
 * revokeOtherSessions مفعَّل دائمًا: تغيير كلمة المرور يعني غالبًا شكًّا في
 * تسريبها، وإبقاء الجلسات الأخرى حيّة يترك المهاجم داخلًا رغم التغيير.
 */

const MIN_PASSWORD_LENGTH = 12;

export interface ChangePasswordLabels {
  title: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  cta: string;
  processing: string;
  changed: string;
  wrong: string;
  policy: string;
  mismatch: string;
  revokeOthers: string;
  unexpectedError: string;
}

export function ChangePasswordForm({ labels }: { labels: ChangePasswordLabels }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setNotice(null);

    const nextErrors: Record<string, string> = {};
    if (current.length === 0) nextErrors.current = labels.policy;
    if (next.length < MIN_PASSWORD_LENGTH) nextErrors.next = labels.policy;
    else if (next !== confirm) nextErrors.confirm = labels.mismatch;

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    startTransition(async () => {
      const res = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });

      if (res.error) {
        // كلمة المرور الحالية الخاطئة تعود بالرمز INVALID_PASSWORD؛ ما عداها
        // يُختصر إلى رسالة عامة حتى لا نسرّب رموز الخادم إلى المتصفح.
        setNotice({
          ok: false,
          text:
            res.error.code === "INVALID_PASSWORD"
              ? labels.wrong
              : labels.unexpectedError,
        });
        return;
      }

      setCurrent("");
      setNext("");
      setConfirm("");
      setNotice({ ok: true, text: labels.changed });
      // الجلسة تُقرأ على الخادم، فأي تجديد للكوكي لا يظهر إلا بإعادة القراءة.
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="font-semibold">{labels.title}</p>

      <Field label={labels.currentPassword} required error={errors.current}>
        <Input
          type="password"
          dir="ltr"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={labels.newPassword}
          required
          error={errors.next}
          hint={labels.policy}
        >
          <Input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>

        <Field label={labels.confirmPassword} required error={errors.confirm}>
          <Input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
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

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? labels.processing : labels.cta}
        </Button>
        <span className="text-xs text-ink-500">{labels.revokeOthers}</span>
      </div>
    </form>
  );
}
