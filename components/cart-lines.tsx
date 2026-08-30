"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { updateCartAction } from "@/app/actions/cart";
import { Badge, Card, cx } from "@/components/ui";
import { formatSar } from "@/lib/pricing";
import type { CartLine } from "@/lib/cart-service";

export function CartLines({ lines }: { lines: CartLine[] }) {
  return (
    <div className="space-y-3">
      {lines.map((line) => (
        <CartLineRow
          key={`${line.aeProductId}|${line.skuAttr}|${line.logisticsServiceName}`}
          line={line}
        />
      ))}
    </div>
  );
}

function CartLineRow({ line }: { line: CartLine }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function change(quantity: number) {
    startTransition(async () => {
      await updateCartAction({
        aeProductId: line.aeProductId,
        skuAttr: line.skuAttr,
        logisticsServiceName: line.logisticsServiceName,
        quantity,
      });
      router.refresh();
    });
  }

  const maxQty = Math.min(20, Math.max(1, line.availableStock));

  return (
    <Card
      className={cx(
        "flex gap-4 p-4 transition",
        pending && "opacity-60",
        line.issue && "border-amber-400",
      )}
    >
      <Link
        href={`/product/${line.aeProductId}`}
        className="size-24 shrink-0 overflow-hidden rounded-lg bg-ink-100 dark:bg-ink-800"
      >
        {line.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={line.imageUrl} alt="" className="size-full object-cover" />
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
            {!line.hasTracking && <Badge tone="warning">بدون تتبع</Badge>}
          </p>
        )}

        {line.issue && (
          <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
            {line.issue}
          </p>
        )}

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center rounded-lg border border-[--color-border-app]">
            <button
              type="button"
              aria-label="إنقاص"
              disabled={pending}
              onClick={() => change(line.quantity - 1)}
              className="size-9 text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              −
            </button>
            <span className="w-10 text-center text-sm nums">{line.quantity}</span>
            <button
              type="button"
              aria-label="زيادة"
              disabled={pending || line.quantity >= maxQty}
              onClick={() => change(line.quantity + 1)}
              className="size-9 text-sm hover:bg-ink-100 disabled:opacity-30 dark:hover:bg-ink-800"
            >
              +
            </button>
          </div>

          <div className="text-left">
            <p className="font-bold nums">{formatSar(line.linePriceSar)}</p>
            {line.shippingSar > 0 && (
              <p className="text-xs text-ink-500 nums">
                + {formatSar(line.shippingSar)} شحن
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={() => change(0)}
            className="text-xs text-red-600 hover:underline dark:text-red-400"
          >
            إزالة
          </button>
        </div>
      </div>
    </Card>
  );
}
