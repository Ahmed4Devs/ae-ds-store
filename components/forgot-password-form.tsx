"use client";

import { useState, useTransition } from "react";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/components/ui";
import type { Dictionary } from "@/lib/i18n/shared";

/**
 * طلب رابط إعادة تعيين كلمة المرور.
 *
 * ⚠️ النتيجة المعروضة **واحدة دائمًا**، نجح الإرسال أم لم ينجح، ووُجد
 * البريد أم لم يوجد. تفريقُ الرسالتين كان سيحوّل هذا النموذج إلى أداة
 * تعداد حسابات: يجرّب المهاجم عناوين بريد ويقرأ من الردّ من له حساب لدينا.
 * وهو السلوك نفسه الذي تلتزمه better-auth في الخادم (تردّ 200 دائمًا).
 */
export function ForgotPasswordForm({ labels }: { labels: Dictionary["auth"] }) {
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schema = z.object({ email: z.email(labels.invalidEmail) });

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setError(null);

    const fd = new FormData(e.currentTarget);
    const parsed = schema.safeParse({ email: String(fd.get("email") ?? "") });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? labels.invalidEmail);
      return;
    }

    startTransition(async () => {
      const res = await authClient.requestPasswordReset({
        email: parsed.data.email,
        // إلزامي: بدونه يُبنى الرابط بوجهة فارغة فيُحوَّل المستخدم بعد
        // الضغط عليه إلى /error — وهو مسار لا وجود له في هذا التطبيق.
        redirectTo: "/reset-password",
      });

      // خطأ الشبكة وحده يُعرض؛ أما نتيجة البحث عن البريد فلا تُكشف
      if (res.error && res.error.status !== 200) {
        setSent(true);
        return;
      }

      setSent(true);
    });
  }

  if (sent) {
    return (
      <Alert tone="success" title={labels.forgotSentTitle}>
        <p>{labels.forgotSentBody}</p>
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label={labels.email} required error={error ?? undefined}>
        <Input
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          placeholder="you@example.com"
        />
      </Field>

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? labels.processing : labels.forgotCta}
      </Button>
    </form>
  );
}
