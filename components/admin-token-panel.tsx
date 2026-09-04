"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshTokenAction, seedTokenAction } from "@/app/actions/admin-token";
import { Alert, Badge, Button } from "@/components/ui";
import { formatDateAr } from "@/lib/ksa";
import { fill, type Dictionary, type Locale } from "@/lib/i18n/shared";

/**
 * حالة تفويض AliExpress وأزرار تجديده.
 *
 * الغرض التشغيلي: رمز الوصول ينتهي دوريًا، وانتهاؤه يوقف كل توريد
 * بصمت — تظهر الطلبيات فاشلة بلا سبب واضح. عرض تاريخ الانتهاء هنا
 * يحوّل العطل المفاجئ إلى موعد معروف مسبقًا.
 */

export interface AdminTokenState {
  present: boolean;
  /** ISO — التواريخ لا تعبر حدود الخادم والعميل ككائن Date */
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  hasRefreshToken: boolean;
}

export function AdminTokenPanel({
  state,
  locale,
  labels,
  isMock,
}: {
  state: AdminTokenState;
  locale: Locale;
  labels: Dictionary["admin"];
  isMock: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run(kind: "refresh" | "seed"): void {
    startTransition(async () => {
      const res =
        kind === "refresh" ? await refreshTokenAction() : await seedTokenAction();

      setMsg({
        ok: res.ok,
        text: res.ok
          ? res.message || (kind === "refresh" ? labels.tokenRefreshed : labels.tokenSeeded)
          : fill(labels.tokenRefreshFailed, { msg: res.message }),
      });
      router.refresh();
    });
  }

  return (
    <div className="mt-4 space-y-4">
      {isMock && (
        <Alert tone="info">{labels.tokenMockNote}</Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={state.present ? "success" : "warning"}>
          {state.present ? labels.tokenPresent : labels.tokenAbsent}
        </Badge>
        {!state.hasRefreshToken && (
          <Badge tone="warning">{labels.tokenNoRefreshToken}</Badge>
        )}
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Row
          text={
            state.expiresAt
              ? fill(labels.tokenExpires, {
                  date: formatDateAr(state.expiresAt, locale),
                })
              : labels.tokenNoExpiry
          }
        />
        {state.refreshExpiresAt && (
          <Row
            text={fill(labels.tokenRefreshExpires, {
              date: formatDateAr(state.refreshExpiresAt, locale),
            })}
          />
        )}
        {state.lastRefreshedAt && (
          <Row
            text={fill(labels.tokenLastRefreshed, {
              date: formatDateAr(state.lastRefreshedAt, locale),
            })}
          />
        )}
      </dl>

      {state.lastError && (
        <Alert tone="danger">
          {fill(labels.tokenRefreshFailed, { msg: state.lastError })}
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          // التجديد بلا رمز تجديد يفشل حتمًا — تعطيل الزر أوضح من رسالة خطأ
          disabled={pending || !state.hasRefreshToken}
          onClick={() => run("refresh")}
        >
          {pending ? labels.tokenRefreshing : labels.tokenRefreshCta}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => run("seed")}
        >
          {labels.tokenSeedCta}
        </Button>
      </div>

      {msg && (
        <p
          className={
            "text-sm " +
            (msg.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400")
          }
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

function Row({ text }: { text: string }) {
  return <div className="nums text-ink-500">{text}</div>;
}
