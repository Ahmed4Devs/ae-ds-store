"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  importProductAction,
  setMarginAction,
  togglePublishAction,
} from "@/app/actions/admin-catalog";
import { Badge, Button, Input } from "@/components/ui";
import { formatSar } from "@/lib/pricing";
import { formatDateAr } from "@/lib/ksa";
import { fill, type Dictionary, type Locale } from "@/lib/i18n/shared";

/**
 * صف منتج في جدول الكتالوج المنسَّق.
 *
 * التحرير داخل الصف لا في صفحة منفصلة: عمل الإدارة هنا هو المقارنة بين
 * المنتجات ثم النشر أو تعديل الهامش، والانتقال بين صفحتين لكل تعديل
 * يفقد سياق المقارنة.
 */

export interface AdminProductRowData {
  id: string;
  aeProductId: string;
  title: string;
  imageUrl: string;
  categoryName: string | null;
  /** سعر أرخص وحدة SKU بعملة المصدر */
  sourcePrice: number | null;
  /** سعر البيع المحسوب بالريال بعد الصرف والهامش */
  retailSar: number | null;
  isPublished: boolean;
  marginPercent: number | null;
  /** ISO — التاريخ لا يعبر حدود الخادم والعميل ككائن Date */
  lastSyncedAt: string | null;
}

export function AdminProductRow({
  product,
  locale,
  labels,
  commonLabels,
  defaultMarginPercent,
  sourceCurrency,
}: {
  product: AdminProductRowData;
  locale: Locale;
  labels: Dictionary["admin"];
  commonLabels: Dictionary["common"];
  defaultMarginPercent: number;
  sourceCurrency: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [published, setPublished] = useState(product.isPublished);
  const [margin, setMargin] = useState(
    product.marginPercent == null ? "" : String(product.marginPercent),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const savedMargin =
    product.marginPercent == null ? "" : String(product.marginPercent);
  const marginDirty = margin.trim() !== savedMargin;

  function togglePublish(): void {
    const next = !published;
    startTransition(async () => {
      const res = await togglePublishAction({
        productId: product.id,
        published: next,
      });
      setMsg({ ok: res.ok, text: res.message });
      // الحالة المحلية لا تُقدَّم على النتيجة: فشل الإجراء يعني بقاء
      // الصف كما هو، وإظهار العكس يجعل المسؤول يظنّ المنتج منشورًا
      if (res.ok) setPublished(next);
      router.refresh();
    });
  }

  function saveMargin(): void {
    const raw = margin.trim();
    // الحقل الفارغ يعني «امسح التخصيص» لا «هامش صفر»
    const value = raw === "" ? null : Number(raw);

    if (value !== null && !Number.isFinite(value)) {
      setMsg({ ok: false, text: labels.marginInvalid });
      return;
    }

    startTransition(async () => {
      const res = await setMarginAction({
        productId: product.id,
        marginPercent: value,
      });
      setMsg({ ok: res.ok, text: res.message });
      router.refresh();
    });
  }

  return (
    <tr className="hover:bg-[--color-background]">
      <td className="px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="size-12 shrink-0 overflow-hidden rounded-lg bg-ink-100 dark:bg-ink-800">
            {product.imageUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={product.imageUrl}
                alt=""
                loading="lazy"
                className="size-full object-cover"
              />
            )}
          </span>
          <span className="min-w-0">
            <Link
              href={`/product/${product.aeProductId}`}
              className="line-clamp-2 max-w-xs text-brand-600 hover:underline"
              title={product.title}
            >
              {product.title}
            </Link>
            <span className="nums mt-0.5 block text-xs text-ink-500" dir="ltr">
              {product.aeProductId}
            </span>
          </span>
        </div>
      </td>

      <td className="px-5 py-3 text-ink-500">
        {product.categoryName ?? commonLabels.none}
      </td>

      <td className="px-5 py-3">
        <span className="nums block font-medium">
          {product.retailSar == null
            ? commonLabels.none
            : formatSar(product.retailSar, locale)}
        </span>
        {product.sourcePrice != null && (
          <span className="nums block text-xs text-ink-500" dir="ltr">
            {product.sourcePrice.toFixed(2)} {sourceCurrency}
          </span>
        )}
      </td>

      <td className="px-5 py-3">
        <div className="flex items-center gap-2">
          <Badge tone={published ? "success" : "neutral"}>
            {published ? labels.published : labels.unpublished}
          </Badge>
          <Button
            variant={published ? "outline" : "primary"}
            size="sm"
            disabled={pending}
            onClick={togglePublish}
          >
            {published ? labels.unpublish : labels.publish}
          </Button>
        </div>
      </td>

      <td className="px-5 py-3">
        <div className="flex items-center gap-2">
          <Input
            className="nums h-9 w-24"
            type="number"
            min={0}
            max={200}
            step={0.5}
            inputMode="decimal"
            dir="ltr"
            value={margin}
            aria-label={labels.marginOverride}
            placeholder={String(defaultMarginPercent)}
            disabled={pending}
            onChange={(e) => setMargin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveMargin();
              }
            }}
          />
          {marginDirty && (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={saveMargin}
            >
              {pending ? commonLabels.saving : commonLabels.save}
            </Button>
          )}
        </div>
        <span className="mt-1 block text-xs text-ink-500">
          {fill(labels.marginDefaultHint, { n: defaultMarginPercent })}
        </span>
      </td>

      <td className="px-5 py-3 text-ink-500">
        {product.lastSyncedAt
          ? formatDateAr(product.lastSyncedAt, locale)
          : commonLabels.none}
        {msg && (
          <span
            className={
              "mt-1 block text-xs " +
              (msg.ok
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400")
            }
          >
            {msg.text}
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * استيراد منتج بمعرّفه لدى AliExpress.
 *
 * وجودها ضروري لأن المرآة لا تمتلئ إلا بزيارة صفحة المنتج، فبناء
 * كتالوج منسَّق كان يستلزم من المسؤول أن يفتح كل منتج بنفسه أولًا.
 */
export function AdminImportForm({
  labels,
}: {
  labels: Dictionary["admin"];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const aeProductId = value.trim();
        if (!aeProductId) return;

        startTransition(async () => {
          const res = await importProductAction({ aeProductId });
          setMsg({ ok: res.ok, text: res.message });
          if (res.ok) setValue("");
          router.refresh();
        });
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">
          {labels.importProduct}
        </span>
        <Input
          className="nums w-64"
          dir="ltr"
          value={value}
          disabled={pending}
          placeholder={labels.importPlaceholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>

      <Button type="submit" disabled={pending || value.trim() === ""}>
        {labels.importCta}
      </Button>

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
    </form>
  );
}
