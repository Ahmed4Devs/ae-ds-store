"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { Button, Field, Input } from "@/components/ui";
import type { Dictionary } from "@/lib/i18n/shared";

type Labels = Dictionary["auth"];

export function AuthForm({
  mode,
  labels,
}: {
  mode: "signin" | "signup";
  labels: Labels;
}) {
  const signinSchema = z.object({
    email: z.email(labels.invalidEmail),
    password: z.string().min(1, labels.passwordRequired),
  });

  /**
   * الحدّ الأدنى اثنا عشر محرفًا — مطابقًا لـ `minPasswordLength` على الخادم.
   *
   * كان ثمانية هنا واثني عشر هناك، فكانت كلمة من تسعة محارف تمرّ التحقق
   * في المتصفّح ويرفضها الخادم بـ PASSWORD_TOO_SHORT، ثم يعرض النموذج
   * رسالته العامة «قد يكون البريد مستخدمًا مسبقًا» — فيبحث المستخدم عن
   * مشكلة في بريده بينما العلّة في طول كلمته.
   */
  const signupSchema = z.object({
    name: z.string().trim().min(2, labels.nameRequired),
    email: z.email(labels.invalidEmail),
    password: z.string().min(12, labels.passwordPolicy),
  });

  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** البريد الذي فشل دخوله لأنه غير مؤكَّد — يفتح زرّ إعادة الإرسال */
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  function resendVerification(email: string): void {
    startTransition(async () => {
      await authClient.sendVerificationEmail({
        email,
        callbackURL: "/login",
      });
      // نعرض النجاح دائمًا: كشفُ فشل الإرسال يكشف وجود الحساب من عدمه
      setResent(true);
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setFormError(null);

    const fd = new FormData(e.currentTarget);
    const raw = {
      name: String(fd.get("name") ?? ""),
      email: String(fd.get("email") ?? ""),
      password: String(fd.get("password") ?? ""),
    };

    const schema = mode === "signup" ? signupSchema : signinSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        const k = String(i.path[0] ?? "form");
        errs[k] ??= i.message;
      }
      setErrors(errs);
      return;
    }

    startTransition(async () => {
      const res =
        mode === "signup"
          ? await authClient.signUp.email({
              name: raw.name,
              email: raw.email,
              password: raw.password,
            })
          : await authClient.signIn.email({
              email: raw.email,
              password: raw.password,
            });

      if (res.error) {
        /**
         * حالة واحدة تستحق رسالة خاصة: البريد غير مؤكَّد.
         *
         * الرسالة العامة («البريد أو كلمة المرور غير صحيحة») تدفع صاحب
         * الحساب إلى تجربة كلمات مرور لا تنفع، بينما المطلوب منه فتح
         * رابط في بريده. أما بقية الأخطاء فتبقى عامة عمدًا حتى لا يصير
         * النموذج أوراكلًا يكشف من له حساب لدينا.
         */
        if (res.error.code === "EMAIL_NOT_VERIFIED") {
          setFormError(labels.emailNotVerified);
          setUnverifiedEmail(raw.email);
          return;
        }

        setFormError(
          mode === "signup" ? labels.signUpFailed : labels.signInFailed,
        );
        return;
      }

      router.push("/account");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {mode === "signup" && (
        <Field label={labels.name} required error={errors.name}>
          <Input name="name" autoComplete="name" placeholder={labels.namePlaceholder} />
        </Field>
      )}

      <Field label={labels.email} required error={errors.email}>
        <Input
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          placeholder="you@example.com"
        />
      </Field>

      <Field
        label={labels.password}
        required
        error={errors.password}
        hint={mode === "signup" ? labels.passwordPolicy : undefined}
      >
        <Input
          name="password"
          type="password"
          dir="ltr"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
      </Field>

      {formError && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <p>{formError}</p>
          {unverifiedEmail && !resent && (
            <button
              type="button"
              onClick={() => resendVerification(unverifiedEmail)}
              disabled={pending}
              className="mt-2 font-medium underline underline-offset-2 disabled:opacity-50"
            >
              {labels.verifyResend}
            </button>
          )}
          {resent && <p className="mt-2 font-medium">{labels.verifyResent}</p>}
        </div>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending
          ? labels.processing
          : mode === "signup"
            ? labels.signUp
            : labels.signIn}
      </Button>
    </form>
  );
}
