"use client";

import { useEffect } from "react";
import { DEFAULT_LOCALE, dictionaries, fill } from "@/lib/i18n/shared";

/**
 * حدّ الخطأ الجذري — يحلّ محلّ app/layout.tsx نفسه حين يفشل التخطيط.
 *
 * لأنه يستبدل التخطيط فهو مسؤول عن <html> و<body> بنفسه، ولا يضمن أن
 * ورقة globals.css أو خط Tajawal قد حُمّلا (فشل التخطيط قد يكون سببه هما).
 * لذلك كل التنسيق مضمّن بقيم صريحة بدل أصناف Tailwind أو متغيّرات CSS:
 * صفحة بلا تنسيق أفضل من صفحة تعتمد على ما انكسر للتوّ.
 *
 * واللغة عربية ثابتة للسبب نفسه في app/error.tsx: كوكي اللغة غير مقروء
 * من مكوّن عميل.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/global-error] root layout failure:", error);
  }, [error]);

  const t = dictionaries[DEFAULT_LOCALE];

  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#ffffff",
          color: "#0f172a",
          fontFamily: "'Segoe UI', system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: "32rem", textAlign: "center" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              margin: "0 auto 20px",
              display: "grid",
              placeItems: "center",
              borderRadius: "12px",
              background: "#059669",
              color: "#ffffff",
              fontSize: "22px",
              fontWeight: 700,
            }}
            aria-hidden="true"
          >
            و
          </div>

          <h1 style={{ margin: "0 0 12px", fontSize: "22px", fontWeight: 700 }}>
            {t.errorPage.globalTitle}
          </h1>

          <p style={{ margin: "0 0 24px", fontSize: "15px", lineHeight: 1.8, color: "#475569" }}>
            {t.errorPage.globalBody}
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              appearance: "none",
              border: "none",
              cursor: "pointer",
              borderRadius: "8px",
              background: "#059669",
              color: "#ffffff",
              padding: "12px 28px",
              fontSize: "15px",
              fontWeight: 500,
              fontFamily: "inherit",
            }}
          >
            {t.errorPage.reload}
          </button>

          {error.digest && (
            <p
              style={{
                margin: "24px 0 0",
                fontSize: "12px",
                color: "#64748b",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fill(t.errorPage.digest, { id: error.digest })}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
