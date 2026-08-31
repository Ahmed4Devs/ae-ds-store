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

  const signupSchema = z.object({
    name: z.string().trim().min(2, labels.nameRequired),
    email: z.email(labels.invalidEmail),
    password: z.string().min(8, labels.passwordTooShort),
  });

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
        hint={mode === "signup" ? labels.passwordHint : undefined}
      >
        <Input
          name="password"
          type="password"
          dir="ltr"
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
          ? labels.processing
          : mode === "signup"
            ? labels.signUp
            : labels.signIn}
      </Button>
    </form>
  );
}
