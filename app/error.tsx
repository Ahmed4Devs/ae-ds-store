"use client";

import { useEffect } from "react";
import { ErrorView } from "@/components/error-view";
import { DEFAULT_LOCALE, dictionaries, fill } from "@/lib/i18n/shared";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * حدّ الخطأ لصفحات المتجر.
 *
 * لماذا العربية دائمًا هنا: هذا مكوّن عميل بحكم متطلّب Next، فلا يستطيع
 * استدعاء getDictionary() — وهي تقرأ كوكي اللغة عبر next/headers، واستيراد
 * "@/lib/i18n" من المتصفّح يسحب next/headers إلى الحزمة ويكسر البناء.
 * لذا نستورد من "@/lib/i18n/shared" (النصف الخالي من الخادم) ونعرض اللغة
 * الافتراضية. المقايضة مقبولة: صفحة خطأ عربية أفضل من صفحة Next الإنجليزية
 * بالاتجاه الخاطئ، والحالة نادرة أصلًا.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // التسجيل في التأثير لا في جسم المكوّن: جسم المكوّن قد يُنفَّذ مرّتين في
  // وضع التطوير، فيتضاعف السطر في السجلّ بلا سبب.
  useEffect(() => {
    console.error(
      "[app/error] unhandled render error:",
      safeErrorKind(error),
      error.digest ?? "NO_DIGEST",
    );
  }, [error]);

  const t = dictionaries[DEFAULT_LOCALE];

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
      <ErrorView
        title={t.errorPage.title}
        body={t.errorPage.body}
        digest={error.digest ? fill(t.errorPage.digest, { id: error.digest }) : null}
        onRetry={reset}
        retryLabel={t.common.tryAgain}
        homeLabel={t.common.goHome}
      />
    </main>
  );
}
