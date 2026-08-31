"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLocaleAction, setThemeAction } from "@/app/actions/preferences";
import { cx } from "@/components/ui";
import { LOCALE_LABELS, type Locale } from "@/lib/i18n/shared";
import type { Theme } from "@/lib/theme";

/** أيقونات صغيرة مضمّنة — أخف من إضافة مكتبة أيقونات كاملة. */
const icons = {
  sun: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
  auto: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 18v3" />
    </svg>
  ),
};

export function ThemeToggle({
  current,
  labels,
}: {
  current: Theme;
  labels: { light: string; dark: string; system: string; theme: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // حالة محلية متفائلة: تُظهر الاختيار فورًا دون انتظار رحلة الخادم
  const [choice, setChoice] = useState<Theme>(current);

  /**
   * تطبيق السمة على عنصر html.
   *
   * يجري داخل تأثير لا داخل معالج النقر: React Compiler يمنع تعديل ما هو
   * معرَّف خارج المكوّن أثناء التصيير، والتأثير هو الموضع الصحيح
   * للتزامن مع نظام خارجي مثل DOM.
   */
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.themeChoice = choice;
    const effective =
      choice === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : choice;
    el.setAttribute("data-theme", effective);
  }, [choice]);

  /** متابعة تغيّر تفضيل النظام ما دام الاختيار "تلقائي". */
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.setAttribute(
        "data-theme",
        mq.matches ? "dark" : "light",
      );
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const options: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
    { value: "light", label: labels.light, icon: icons.sun },
    { value: "dark", label: labels.dark, icon: icons.moon },
    { value: "system", label: labels.system, icon: icons.auto },
  ];

  function pick(value: Theme) {
    setChoice(value);
    startTransition(async () => {
      await setThemeAction(value);
      router.refresh();
    });
  }

  return (
    <div
      role="group"
      aria-label={labels.theme}
      className={cx(
        "flex items-center gap-0.5 rounded-full border border-[--color-border-app] p-0.5",
        pending && "opacity-60",
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => pick(o.value)}
          title={o.label}
          aria-label={o.label}
          aria-pressed={choice === o.value}
          className={cx(
            "grid size-8 place-items-center rounded-full transition",
            choice === o.value
              ? "bg-brand-600 text-white"
              : "text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800",
          )}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

export function LanguageSwitcher({
  current,
  label,
}: {
  current: Locale;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const other: Locale = current === "ar" ? "en" : "ar";

  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`${label}: ${LOCALE_LABELS[other]}`}
      title={LOCALE_LABELS[other]}
      onClick={() =>
        startTransition(async () => {
          await setLocaleAction(other);
          router.refresh();
        })
      }
      className={cx(
        "flex h-9 items-center gap-1.5 rounded-full border border-[--color-border-app] px-3 text-sm font-medium transition hover:border-brand-400 hover:text-brand-700",
        pending && "opacity-60",
      )}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
      </svg>
      <span>{LOCALE_LABELS[other]}</span>
    </button>
  );
}
