"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { Button, Field, Input } from "@/components/ui";

const signinSchema = z.object({
  email: z.email("البريد الإلكتروني غير صالح"),
  password: z.string().min(1, "كلمة المرور مطلوبة"),
});

const signupSchema = z.object({
  name: z.string().trim().min(2, "الاسم مطلوب"),
  email: z.email("البريد الإلكتروني غير صالح"),
  password: z.string().min(8, "كلمة المرور ثمانية أحرف على الأقل"),
});

export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

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
        setFormError(
          mode === "signup"
            ? "تعذّر إنشاء الحساب. قد يكون البريد مستخدمًا مسبقًا."
            : "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
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
        <Field label="الاسم" required error={errors.name}>
          <Input name="name" autoComplete="name" placeholder="اسمك الكامل" />
        </Field>
      )}

      <Field label="البريد الإلكتروني" required error={errors.email}>
        <Input
          name="email"
          type="email"
          dir="ltr"
          className="text-right"
          autoComplete="email"
          placeholder="you@example.com"
        />
      </Field>

      <Field
        label="كلمة المرور"
        required
        error={errors.password}
        hint={mode === "signup" ? "ثمانية أحرف على الأقل" : undefined}
      >
        <Input
          name="password"
          type="password"
          dir="ltr"
          className="text-right"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
      </Field>

      {formError && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {formError}
        </p>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending
          ? "جارٍ المعالجة…"
          : mode === "signup"
            ? "إنشاء الحساب"
            : "تسجيل الدخول"}
      </Button>
    </form>
  );
}
