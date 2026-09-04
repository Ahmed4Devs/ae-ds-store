import { Alert, Button, ButtonLink, EmptyState } from "@/components/ui";

/**
 * العرض المشترك لحالات الفشل والصفحات المفقودة.
 *
 * وُحّد هنا لأن حدود الخطأ في Next لا بدّ أن تكون مكوّنات عميل، بينما
 * صفحة «غير موجود» مكوّن خادم — ولولا هذا الملف لتكرّر التصميم مرّتين
 * وتباعد شكلاهما مع أول تعديل. الملف بلا "use client" عمدًا: يُترجم ضمن
 * حزمة العميل حين يستورده حد الخطأ، ويبقى مكوّن خادم حين تستورده
 * صفحة «غير موجود»، فلا تُحمَّل الصفحة الثانية جافاسكربت لا تحتاجه.
 *
 * لذلك أيضًا `onRetry` اختياري: تمرير دالة لا يجوز إلا من حدّ عميل.
 */
export interface ErrorViewProps {
  title: string;
  body: string;
  /** سطر مرجع الخطأ الجاهز (digest) — يُعرض فقط حين يوفّره Next. */
  digest?: string | null;
  /** إعادة المحاولة — تُمرَّر من حدود الخطأ فقط. */
  onRetry?: () => void;
  retryLabel?: string;
  homeLabel: string;
  /** إجراء ثانوي (البحث مثلًا) يظهر قبل زر الرئيسية. */
  secondary?: { href: string; label: string };
}

export function ErrorView({
  title,
  body,
  digest,
  onRetry,
  retryLabel,
  homeLabel,
  secondary,
}: ErrorViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <EmptyState
        title={title}
        description={body}
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            {onRetry && retryLabel && (
              <Button type="button" onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
            {secondary && (
              <ButtonLink href={secondary.href} variant="secondary">
                {secondary.label}
              </ButtonLink>
            )}
            <ButtonLink href="/" variant="outline">
              {homeLabel}
            </ButtonLink>
          </div>
        }
      />

      {digest && (
        // المرجع معرّف تقني لا رسالة خطأ: يفيد الدعم في ربط الشكوى بسجل
        // الخادم، ولا يكشف شيئًا عن سبب العطل للزائر.
        <div className="nums mt-6">
          <Alert tone="warning">{digest}</Alert>
        </div>
      )}
    </div>
  );
}
