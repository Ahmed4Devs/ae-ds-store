"use client";

import { useState, useTransition } from "react";
import { dismissBannerAction } from "@/app/actions/preferences";

/**
 * شريط إعلان قابل للإغلاق.
 *
 * الخادم يقرّر الظهور الأولي من كوكي (فلا وميض)، وهذا المكوّن يضيف زرّ
 * الإغلاق: يُخفي الشريط فورًا (حالة محلية متفائلة) ويثبّت الإغلاق في كوكي
 * عبر إجراء خادم حتى لا يعود في التنقّلات والزيارات التالية.
 */
export function AnnouncementBar({
  children,
  closeLabel,
}: {
  children: React.ReactNode;
  closeLabel: string;
}) {
  const [visible, setVisible] = useState(true);
  const [, startTransition] = useTransition();

  if (!visible) return null;

  return (
    <div className="relative flex min-h-11 items-center justify-center bg-amber-500 px-12 py-1.5 text-center text-xs font-medium text-amber-950">
      {children}
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={() => {
          setVisible(false);
          startTransition(async () => {
            await dismissBannerAction();
          });
        }}
        className="absolute end-0 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded text-amber-950/70 transition hover:text-amber-950"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
