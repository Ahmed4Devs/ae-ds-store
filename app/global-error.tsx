"use client";

import { useEffect } from "react";
import { DEFAULT_LOCALE, dictionaries, fill } from "@/lib/i18n/shared";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * حدّ الخطأ الجذري — يحلّ محلّ app/layout.tsx نفسه حين يفشل التخطيط.
 *
 * لأنه يستبدل التخطيط فهو مسؤول عن <html> و<body> بنفسه، ولا يضمن أن
 * لا نستخدم style attributes هنا: سياسة CSP تمنع الأنماط السطرية حتى لا
 * تتحول أي نقطة حقن HTML مستقبلية إلى حقن CSS. الأصناف ذات قيم fallback
 * صريحة في globals.css وتبقى الصفحة مفهومة حتى إن تعذّر تحميل الورقة.
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
    console.error(
      "[app/global-error] root layout failure:",
      safeErrorKind(error),
      error.digest ?? "NO_DIGEST",
    );
  }, [error]);

  const t = dictionaries[DEFAULT_LOCALE];

  return (
    <html lang="ar" dir="rtl">
      <body className="global-error-body">
        <main className="global-error-main">
          <div className="global-error-mark" aria-hidden="true">
            و
          </div>

          <h1 className="global-error-title">
            {t.errorPage.globalTitle}
          </h1>

          <p className="global-error-copy">
            {t.errorPage.globalBody}
          </p>

          <button
            type="button"
            onClick={reset}
            className="global-error-button"
          >
            {t.errorPage.reload}
          </button>

          {error.digest && (
            <p className="global-error-digest">
              {fill(t.errorPage.digest, { id: error.digest })}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
