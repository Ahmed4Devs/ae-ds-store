"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLocaleAction, setThemeAction } from "@/app/actions/preferences";
import { cx } from "@/components/ui";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/shared";
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
  globe: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
};

/**
 * قائمة منسدلة صغيرة تُفتح من زرّ دائري.
 *
 * تُغلق بالنقر خارجها أو بمفتاح Escape. الاستماع يجري داخل تأثير (لا في
 * التصيير) توافقًا مع React Compiler، ويُزال عند الإغلاق.
 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, ref };
}

/** الزرّ الدائري المُشغِّل للقائمة. */
function TriggerButton({
  open,
  onClick,
  ariaLabel,
  pending,
  children,
}: {
  open: boolean;
  onClick: () => void;
  ariaLabel: string;
  pending?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={open}
      className={cx(
        "grid size-9 place-items-center rounded-full border border-[--color-border-app] transition",
        open
          ? "border-brand-400 text-brand-700"
          : "text-ink-600 hover:border-brand-400 hover:text-brand-700 dark:text-ink-300",
        pending && "opacity-60",
      )}
    >
      {children}
    </button>
  );
}

/** لوح القائمة المنسدلة. */
function MenuPanel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="menu"
      aria-label={label}
      className="absolute end-0 top-full z-50 mt-2 min-w-[9rem] rounded-xl border border-[--color-border-app] bg-[--color-surface] p-1 shadow-lg"
    >
      {children}
    </div>
  );
}

/** عنصر واحد داخل القائمة (خيار قابل للاختيار). */
function MenuItem({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
        active
          ? "bg-brand-50 font-semibold text-brand-700 dark:bg-brand-600/15 dark:text-brand-300"
          : "text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 text-start">{children}</span>
      <span className={cx("shrink-0 text-brand-600", !active && "invisible")}>
        {icons.check}
      </span>
    </button>
  );
}

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
  const { open, setOpen, ref } = useMenu();

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

  const currentIcon =
    choice === "light" ? icons.sun : choice === "dark" ? icons.moon : icons.auto;

  function pick(value: Theme) {
    setChoice(value);
    setOpen(false);
    startTransition(async () => {
      await setThemeAction(value);
      router.refresh();
    });
  }

  return (
    <div ref={ref} className="relative">
      <TriggerButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        ariaLabel={labels.theme}
        pending={pending}
      >
        {currentIcon}
      </TriggerButton>

      {open && (
        <MenuPanel label={labels.theme}>
          {options.map((o) => (
            <MenuItem
              key={o.value}
              active={choice === o.value}
              onClick={() => pick(o.value)}
              icon={o.icon}
            >
              {o.label}
            </MenuItem>
          ))}
        </MenuPanel>
      )}
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
  const { open, setOpen, ref } = useMenu();

  function pick(value: Locale) {
    setOpen(false);
    if (value === current) return;
    startTransition(async () => {
      await setLocaleAction(value);
      router.refresh();
    });
  }

  return (
    <div ref={ref} className="relative">
      <TriggerButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        ariaLabel={`${label} — ${LOCALE_LABELS[current]}`}
        pending={pending}
      >
        {icons.globe}
      </TriggerButton>

      {open && (
        <MenuPanel label={label}>
          {LOCALES.map((loc) => (
            <MenuItem
              key={loc}
              active={loc === current}
              onClick={() => pick(loc)}
              icon={icons.globe}
            >
              {LOCALE_LABELS[loc]}
            </MenuItem>
          ))}
        </MenuPanel>
      )}
    </div>
  );
}
