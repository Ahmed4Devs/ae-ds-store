"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startPaymentAction } from "@/app/actions/payment";
import { Alert, Button } from "@/components/ui";

/**
 * لوحة الدفع.
 *
 * تتعامل مع نوعين مختلفين جوهريًا:
 *  • المزوّد اليدوي — لا صفحة خارجية، فالتعليمات والمرجع يُعرضان هنا
 *    وينتهي دور العميل عند التحويل.
 *  • بوابة مستضافة — نُنشئ النيّة ثم نغادر إلى صفحة المزوّد.
 *
 * لا استقصاء دوري هنا: التأكيد يصل عبر إشعار خادم-إلى-خادم يعيد بناء
 * الصفحة، والعميل يعود إليها بتحويل من المزوّد. إضافة مؤقّت يستجوب
 * الخادم كل ثوانٍ كانت ستُثقل مسارًا لا يتغيّر إلا بحدث خارجي واحد.
 */

export interface PaymentPanelLabels {
  payNow: string;
  processing: string;
  redirecting: string;
  continueToProvider: string;
  manualTitle: string;
  manualBody: string;
  manualReferenceNote: string;
  reference: string;
  createFailed: string;
  retry: string;
}

export function PaymentPanel({
  orderNumber,
  isManual,
  providerRef,
  checkoutUrl,
  canRetry,
  labels,
}: {
  orderNumber: string;
  isManual: boolean;
  /** مرجع النيّة القائمة إن وُجدت */
  providerRef: string | null;
  checkoutUrl: string | null;
  /** انتهت المهلة أو فشلت المحاولة السابقة، فيُعرض زرّ محاولة جديدة */
  canRetry: boolean;
  labels: PaymentPanelLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  function start(): void {
    setError(null);
    startTransition(async () => {
      const res = await startPaymentAction({ orderNumber });

      if (!res.ok) {
        setError(res.message);
        return;
      }

      if (res.checkoutUrl) {
        // مغادرة كاملة لا إطار: صفحة المزوّد تتعامل مع 3-D Secure وتحويلات
        // المصرف، وحصرُها في إطار يكسر بعضها بلا رسالة خطأ.
        setLeaving(true);
        window.location.assign(res.checkoutUrl);
        return;
      }

      // المزوّد اليدوي — لا صفحة خارجية، تظهر التعليمات بعد إعادة البناء
      router.refresh();
    });
  }

  // ------------------------------------------------------- المزوّد اليدوي
  if (isManual) {
    return (
      <div className="space-y-4">
        <Alert tone="info" title={labels.manualTitle}>
          <p>{labels.manualBody}</p>
        </Alert>

        {providerRef ? (
          <div className="rounded-lg border border-[--color-border-app] bg-[--color-surface] p-4">
            <p className="text-sm text-ink-500">{labels.reference}</p>
            <p className="nums mt-1 font-mono text-sm font-semibold" dir="ltr">
              {providerRef}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              {labels.manualReferenceNote}
            </p>
          </div>
        ) : (
          <Button onClick={start} disabled={pending} size="lg">
            {pending ? labels.processing : labels.payNow}
          </Button>
        )}

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    );
  }

  // ------------------------------------------------------ بوابة مستضافة
  return (
    <div className="space-y-4">
      {checkoutUrl && !canRetry ? (
        // نيّة قائمة لم تُسوّ بعد: نعيد العميل إلى صفحة المزوّد نفسها بدل
        // إنشاء نيّة ثانية تُربك المطابقة لدى المزوّد.
        <Button
          size="lg"
          onClick={() => {
            setLeaving(true);
            window.location.assign(checkoutUrl);
          }}
          disabled={leaving}
        >
          {leaving ? labels.redirecting : labels.continueToProvider}
        </Button>
      ) : (
        <Button onClick={start} disabled={pending || leaving} size="lg">
          {leaving
            ? labels.redirecting
            : pending
              ? labels.processing
              : canRetry
                ? labels.retry
                : labels.payNow}
        </Button>
      )}

      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
