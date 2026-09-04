import { DEFAULT_LOCALE, dictionaries } from "@/lib/i18n/shared";

/**
 * هيكل التحميل لصفحات القوائم.
 *
 * ⚠️ مقصور على هذا المقطع عمدًا، ولا يجوز رفعه إلى `app/loading.tsx`.
 *
 * السبب أن ملف تحميل على جذر التطبيق يلفّ كل صفحة بحدّ Suspense، فيُرسل
 * Next قشرة الصفحة **بحالة 200 فورًا** ثم يبثّ البقية. وعندها لا يعود
 * `notFound()` قادرًا على تغيير رمز الحالة بعد إرساله: تُعرض صفحة «غير
 * موجودة» بحالة 200 — أي صفحة 404 كاذبة تفهرسها محركات البحث كصفحة
 * قائمة، ولا ترصدها أدوات المراقبة كرابط مكسور.
 *
 * قيس عمليًّا: مع الملف على الجذر ردّت `/orders/<رقم-غير-موجود>` و
 * `/product/<معرّف-غير-موجود>` بـ 200؛ وبنقله إلى هذين المقطعين عادتا 404.
 * وهذان المقطعان آمنان لأن أيًّا منهما لا يستدعي `notFound()`.
 */
export default function Loading() {
  const t = dictionaries[DEFAULT_LOCALE];

  return (
    <main
      className="mx-auto w-full max-w-7xl flex-1 px-4 py-8"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">{t.common.loading}</span>

      {/* مساحة العنوان */}
      <div className="mb-6 animate-pulse space-y-3">
        <div className="h-7 w-56 rounded-lg bg-(--color-surface)" />
        <div className="h-4 w-32 rounded bg-(--color-surface)" />
      </div>

      {/* شبكة البطاقات — نفس أعمدة ProductGrid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="animate-pulse overflow-hidden rounded-xl border border-(--color-border-app) bg-(--color-surface)"
            aria-hidden="true"
          >
            <div className="aspect-square w-full bg-ink-100 dark:bg-ink-800" />
            <div className="space-y-2 p-3">
              <div className="h-3.5 w-full rounded bg-ink-100 dark:bg-ink-800" />
              <div className="h-3.5 w-2/3 rounded bg-ink-100 dark:bg-ink-800" />
              <div className="h-5 w-24 rounded bg-ink-100 dark:bg-ink-800" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
