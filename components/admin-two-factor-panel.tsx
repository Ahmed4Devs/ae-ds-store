"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import QRCode from "qrcode";
import { authClient } from "@/lib/auth-client";
import type { Dictionary } from "@/lib/i18n/shared";
import { Alert, Button, Field, Input } from "@/components/ui";

interface EnrollmentData {
  qrDataUrl: string;
  manualSecret: string;
  backupCodes: string[];
}

interface AdminTwoFactorPanelProps {
  enabled: boolean;
  sessionVerified: boolean;
  labels: Dictionary["account"];
  processingLabel: string;
}

const TOTP_CODE = /^\d{6}$/u;
const BACKUP_CODE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{7}$/u;

function validBackupCodes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === 10 &&
    value.every((code) => typeof code === "string" && BACKUP_CODE.test(code))
  );
}

function RecoveryCodes({
  codes,
  title,
  body,
}: {
  codes: string[];
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="font-semibold text-amber-900 dark:text-amber-100">{title}</p>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{body}</p>
      <ul
        className="mt-3 grid gap-2 font-mono text-sm sm:grid-cols-2"
        dir="ltr"
        aria-label={title}
      >
        {codes.map((code) => (
          <li
            key={code}
            className="select-all rounded border border-amber-200 bg-white px-3 py-2 text-center tracking-wide text-ink-900 dark:border-amber-800 dark:bg-ink-950 dark:text-ink-100"
          >
            {code}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AdminTwoFactorPanel({
  enabled,
  sessionVerified,
  labels,
  processingLabel,
}: AdminTwoFactorPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [savedCodes, setSavedCodes] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentData | null>(null);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regeneratePassword, setRegeneratePassword] = useState("");
  const [regeneratedCodes, setRegeneratedCodes] = useState<string[] | null>(
    null,
  );

  function beginEnrollment(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (password.length === 0 || password.length > 128) {
      setError(labels.twoFactorFailed);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await authClient.twoFactor.enable({
        password,
        method: "totp",
      });
      const data = result.data;
      if (
        result.error ||
        !data ||
        data.method !== "totp" ||
        !("totpURI" in data) ||
        typeof data.totpURI !== "string" ||
        !("backupCodes" in data) ||
        !validBackupCodes(data.backupCodes)
      ) {
        setError(labels.twoFactorFailed);
        return;
      }

      let manualSecret = "";
      try {
        const parsed = new URL(data.totpURI);
        if (parsed.protocol !== "otpauth:") throw new Error("invalid protocol");
        manualSecret = parsed.searchParams.get("secret") ?? "";
        if (!/^[A-Z2-7]{16,128}$/u.test(manualSecret)) {
          throw new Error("invalid secret");
        }
      } catch {
        setError(labels.twoFactorFailed);
        return;
      }

      try {
        const qrDataUrl = await QRCode.toDataURL(data.totpURI, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 240,
        });
        setEnrollment({
          qrDataUrl,
          manualSecret,
          backupCodes: data.backupCodes,
        });
        setPassword("");
      } catch {
        setError(labels.twoFactorFailed);
      }
    });
  }

  function finishEnrollment(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!enrollment || !savedCodes || !TOTP_CODE.test(code)) {
      setError(labels.twoFactorFailed);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await authClient.twoFactor.verifyTotp({
        code,
        trustDevice: false,
      });
      if (result.error || !result.data) {
        setError(labels.twoFactorFailed);
        return;
      }

      setCode("");
      setCompleted(true);
      router.refresh();
    });
  }

  function regenerateRecoveryCodes(
    event: React.FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault();
    if (
      regeneratePassword.length === 0 ||
      regeneratePassword.length > 128
    ) {
      setError(labels.twoFactorFailed);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await authClient.twoFactor.generateBackupCodes({
        password: regeneratePassword,
      });
      if (result.error || !validBackupCodes(result.data?.backupCodes)) {
        setError(labels.twoFactorFailed);
        return;
      }

      setRegeneratedCodes(result.data.backupCodes);
      setRegeneratePassword("");
    });
  }

  if (completed && enrollment) {
    return (
      <div className="space-y-4">
        <Alert tone="success">{labels.twoFactorComplete}</Alert>
        <RecoveryCodes
          codes={enrollment.backupCodes}
          title={labels.twoFactorRecoveryTitle}
          body={labels.twoFactorRecoveryBody}
        />
      </div>
    );
  }

  if (enabled) {
    return (
      <div className="space-y-4">
        <Alert tone={sessionVerified ? "success" : "warning"}>
          {sessionVerified
            ? labels.twoFactorEnabled
            : labels.twoFactorSessionPending}
        </Alert>

        {sessionVerified && (
          <form className="space-y-3" onSubmit={regenerateRecoveryCodes}>
            <p className="text-sm text-ink-500">
              {labels.twoFactorRecoveryBody}
            </p>
            <Field label={labels.twoFactorPassword} required>
              <Input
                type="password"
                dir="ltr"
                autoComplete="current-password"
                maxLength={128}
                value={regeneratePassword}
                onChange={(event) => setRegeneratePassword(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? processingLabel : labels.twoFactorRegenerate}
            </Button>
          </form>
        )}

        {regeneratedCodes && (
          <RecoveryCodes
            codes={regeneratedCodes}
            title={labels.twoFactorRegenerated}
            body={labels.twoFactorRecoveryBody}
          />
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" aria-live="polite">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (!enrollment) {
    return (
      <form className="space-y-4" onSubmit={beginEnrollment}>
        <Alert tone="warning" title={labels.twoFactorRequiredTitle}>
          {labels.twoFactorRequiredBody}
        </Alert>
        <p className="text-sm text-ink-500">{labels.twoFactorIntro}</p>
        <Field label={labels.twoFactorPassword} required>
          <Input
            type="password"
            dir="ltr"
            autoComplete="current-password"
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" aria-live="polite">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? processingLabel : labels.twoFactorStart}
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-500">{labels.twoFactorScan}</p>
      <div className="flex justify-center">
        <Image
          src={enrollment.qrDataUrl}
          width={240}
          height={240}
          alt={labels.twoFactorScan}
          unoptimized
          className="rounded-lg bg-white p-2"
        />
      </div>
      <div>
        <p className="text-sm font-medium">{labels.twoFactorManualKey}</p>
        <code
          className="mt-1 block select-all break-all rounded-lg bg-ink-100 p-3 text-center text-sm tracking-wider text-ink-900 dark:bg-ink-900 dark:text-ink-100"
          dir="ltr"
        >
          {enrollment.manualSecret}
        </code>
      </div>

      <RecoveryCodes
        codes={enrollment.backupCodes}
        title={labels.twoFactorRecoveryTitle}
        body={labels.twoFactorRecoveryBody}
      />

      <form className="space-y-4" onSubmit={finishEnrollment}>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={savedCodes}
            onChange={(event) => setSavedCodes(event.target.checked)}
            className="mt-1"
          />
          <span>{labels.twoFactorSavedConfirm}</span>
        </label>
        <Field label={labels.twoFactorCode} required>
          <Input
            type="text"
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))
            }
          />
        </Field>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" aria-live="polite">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending || !savedCodes}>
          {pending ? processingLabel : labels.twoFactorVerify}
        </Button>
      </form>
    </div>
  );
}
