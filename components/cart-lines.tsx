"use client";

import Link from "next/link";
import { Badge, Card, cx } from "@/components/ui";
import { useUpdateCartItem } from "@/lib/query/hooks";
import { formatSar } from "@/lib/pricing/format";
import type { CartLine } from "@/lib/cart-service";
import type { Locale } from "@/lib/i18n/shared";

export interface CartLineLabels {
  remove: string;
  increase: string;
  decrease: string;
  notTrackable: string;
  shippingSuffix: string;
}

export function CartLines({
  lines,
  labels,
  locale = "ar",
}: {
  lines: CartLine[];
  labels: CartLineLabels;
  locale?: Locale;
}) {
  return (
    <div className="space-y-3">
      {lines.map((line) => (
        <CartLineRow
          key={`${line.aeProductId}|${line.skuAttr}|${line.logisticsServiceName}`}
          line={line}
          labels={labels}
          locale={locale}
        />
      ))}
    </div>
  );
}

function CartLineRow({
  line,
  labels,
  locale,
}: {
  line: CartLine;
  labels: CartLineLabels;
  locale: Locale;
}) {
  const updateItem = useUpdateCartItem();
  const pending = updateItem.isPending;

  function change(quantity: number) {
    updateItem.mutate({
      aeProductId: line.aeProductId,
      skuAttr: line.skuAttr,
      logisticsServiceName: line.logisticsServiceName,
      quantity,
    });
  }

  const maxQty = Math.min(20, Math.max(1, line.availableStock));

  return (
    <Card
      className={cx(
        "flex items-start gap-3 p-3 transition sm:gap-4 sm:p-4",
        pending && "opacity-60",
        line.issue && "border-amber-400",
      )}
    >
      <Link
        href={`/product/${line.aeProductId}`}
        className="size-20 shrink-0 overflow-hidden rounded-lg bg-ink-100 sm:size-24 dark:bg-ink-800"
      >
        {line.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={line.imageUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="size-full object-cover"
          />
        ) : null}
      </Link>

      <div className="min-w-0 flex-1">
        <Link
          href={`/product/${line.aeProductId}`}
          className="line-clamp-2 text-sm font-medium hover:text-brand-600"
        >
          {line.title}
        </Link>

        {line.variantLabel && (
          <p className="mt-1 text-xs text-ink-500">{line.variantLabel}</p>
        )}

        {line.shippingCompany && (
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-500">
            <span>
              {line.shippingCompany} · {line.shippingEstimate}
            </span>
            {!line.hasTracking && <Badge tone="warning">{labels.notTrackable}</Badge>}
          </p>
        )}

        {line.issue && (
          <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
            {line.issue}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center rounded-lg border border-(--color-border-app)">
            <button
              type="button"
              aria-label={labels.decrease}
              disabled={pending}
              onClick={() => change(line.quantity - 1)}
              className="size-11 text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              −
            </button>
            <span className="w-10 text-center text-sm nums">{line.quantity}</span>
            <button
              type="button"
              aria-label={labels.increase}
              disabled={pending || line.quantity >= maxQty}
              onClick={() => change(line.quantity + 1)}
              className="size-11 text-sm hover:bg-ink-100 disabled:opacity-30 dark:hover:bg-ink-800"
            >
              +
            </button>
          </div>

          <div className="text-left">
            <p className="font-bold nums">{formatSar(line.linePriceSar, locale)}</p>
            {line.shippingSar > 0 && (
              <p className="text-xs text-ink-500 nums">
                + {formatSar(line.shippingSar, locale)} {labels.shippingSuffix}
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={() => change(0)}
            className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs text-red-600 hover:underline dark:text-red-400"
          >
            {labels.remove}
          </button>
        </div>
      </div>
    </Card>
  );
}
