"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import type { Dictionary } from "@/lib/i18n/shared";
import { Button, Field, Input } from "@/components/ui";

type Labels = Dictionary["auth"];
type ChallengeMode = "totp" | "recovery";

const TOTP_CODE = /^\d{6}$/u;
const RECOVERY_CODE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{7}$/u;

export function TwoFactorChallenge({ labels }: { labels: Labels }) {
  const [mode, setMode] = useState<ChallengeMode>("totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function changeMode(nextMode: ChallengeMode): void {
    setMode(nextMode);
    setCode("");
    setError(null);
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const valid =
      mode === "totp" ? TOTP_CODE.test(code) : RECOVERY_CODE.test(code);
    if (!valid) {
      setError(labels.invalidTwoFactor);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp({
              code,
              trustDevice: false,
            })
          : await authClient.twoFactor.verifyBackupCode({
              code,
              trustDevice: false,
              disableSession: false,
            });

      if (result.error || !result.data) {
        setError(
          result.error?.code === "ACCOUNT_TEMPORARILY_LOCKED"
            ? labels.lockedTwoFactor
            : labels.invalidTwoFactor,
        );
        return;
      }

      // تنقّل كامل حتى لا تبقى حمولة صفحة التحدّي ولا قيمة الرمز في شجرة
      // React بعد إنشاء كوكي الجلسة الجديدة.
      window.location.replace("/account");
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        label={
          mode === "totp" ? labels.authenticatorCode : labels.recoveryCode
        }
        required
        hint={mode === "totp" ? labels.authenticatorCodeHint : undefined}
      >
        <Input
          type="text"
          dir="ltr"
          inputMode={mode === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          spellCheck={false}
          pattern={
            mode === "totp"
              ? "[0-9]{6}"
              : "[A-Za-z0-9]{5}-[A-Za-z0-9]{7}"
          }
          minLength={mode === "totp" ? 6 : 13}
          maxLength={mode === "totp" ? 6 : 13}
          value={code}
          onChange={(event) => {
            const value =
              mode === "totp"
                ? event.target.value.replace(/\D/gu, "").slice(0, 6)
                : event.target.value.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 13);
            setCode(value);
          }}
        />
      </Field>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" aria-live="polite">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? labels.processing : labels.verifyTwoFactor}
      </Button>

      <div className="flex flex-col items-center gap-2 text-sm">
        <button
          type="button"
          className="font-medium text-brand-600 hover:underline"
          onClick={() => changeMode(mode === "totp" ? "recovery" : "totp")}
          disabled={pending}
        >
          {mode === "totp"
            ? labels.useRecoveryCode
            : labels.useAuthenticatorCode}
        </button>
        <Link href="/login" className="text-ink-500 hover:underline">
          {labels.backToLogin}
        </Link>
      </div>
    </form>
  );
}
