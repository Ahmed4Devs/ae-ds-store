"use client";

import { useState } from "react";
import { Button, cx } from "@/components/ui";
import { formatSar } from "@/lib/pricing";
import { fill, type Locale } from "@/lib/i18n/shared";
import { useAddToCart, useShippingOptions } from "@/lib/query/hooks";

export interface SkuOption {
  skuAttr: string;
  label: string;
  stock: number;
  priceSar: number;
}

export interface AddToCartLabels {
  variant: string;
  available: string;
  shippingMethod: string;
  trackable: string;
  notTrackable: string;
  free: string;
  quantity: string;
  addToCart: string;
  adding: string;
  increase: string;
  decrease: string;
  lineProduct: string;
  lineShipping: string;
  totalNote: string;
  updatingShipping: string;
  shippingErrorTitle: string;
}

export function AddToCartForm({
  aeProductId,
  skus,
  labels,
  locale = "ar",
}: {
  aeProductId: string;
  skus: SkuOption[];
  labels: AddToCartLabels;
  locale?: Locale;
}) {
  const firstAvailable = skus.find((s) => s.stock > 0) ?? skus[0];
  const [skuAttr, setSkuAttr] = useState(firstAvailable.skuAttr);
  const [qty, setQty] = useState(1);
  const [shipCode, setShipCode] = useState<string | null>(null);

  /**
   * خيارات الشحن تُجلب لكل كمية على حدة.
   *
   * هذا ما يصحّح عيبًا حقيقيًا: كانت الأجرة تُحسب على الخادم لكمية واحدة
   * فقط، فيبقى المبلغ المعروض خاطئًا عند زيادة الكمية. المفتاح يتضمّن
   * الكمية، فتغييرها يُطلق استعلامًا جديدًا تلقائيًا.
   */
  const shippingQuery = useShippingOptions(aeProductId, qty);
  const shipping = shippingQuery.data ?? [];

  const addToCart = useAddToCart();

  const selectedSku = skus.find((s) => s.skuAttr === skuAttr) ?? firstAvailable;
  const maxQty = Math.min(20, Math.max(1, selectedSku.stock));

  // الخيار المختار، أو أول خيار قابل للتتبع إن لم يُختر شيء بعد
  const selectedShip =
    shipping.find((s) => s.code === shipCode) ??
    shipping.find((s) => s.hasTracking) ??
    shipping[0];

  const canSubmit =
    Boolean(selectedShip) && selectedSku.stock > 0 && !addToCart.isPending;

  function submit() {
    if (!selectedShip) return;
    addToCart.mutate({
      aeProductId,
      skuAttr,
      quantity: qty,
      logisticsServiceName: selectedShip.code,
    });
  }

  return (
    <div className="space-y-6">
      {skus.length > 1 && (
        <div>
          <p className="mb-2 text-sm font-medium">{labels.variant}</p>
          <div className="flex flex-wrap gap-2">
            {skus.map((s) => {
              const out = s.stock === 0;
              return (
                <button
                  key={s.skuAttr}
                  type="button"
                  disabled={out}
                  onClick={() => {
                    setSkuAttr(s.skuAttr);
                    setQty(1);
                  }}
                  className={cx(
                    "rounded-lg border px-4 py-2 text-sm transition",
                    out && "cursor-not-allowed opacity-40 line-through",
                    s.skuAttr === skuAttr
                      ? "border-brand-600 bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/30 dark:text-brand-200"
                      : "border-(--color-border-app) hover:border-brand-400",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="nums mt-2 text-xs text-ink-500">
            {fill(labels.available, { n: selectedSku.stock })}
          </p>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <p className="text-sm font-medium">{labels.shippingMethod}</p>
          {shippingQuery.isFetching && (
            <span className="flex items-center gap-1.5 text-xs text-ink-500">
              <span className="size-3 animate-spin rounded-full border-2 border-ink-300 border-t-brand-600" />
              {labels.updatingShipping}
            </span>
          )}
        </div>

        {shippingQuery.isError ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {labels.shippingErrorTitle}
          </p>
        ) : (
          <div
            className={cx(
              "space-y-2 transition-opacity",
              shippingQuery.isFetching && "opacity-60",
            )}
          >
            {shipping.map((o) => (
              <label
                key={o.code}
                className={cx(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition",
                  o.code === selectedShip?.code
                    ? "border-brand-600 bg-brand-50 dark:bg-brand-900/20"
                    : "border-(--color-border-app) hover:border-brand-400",
                )}
              >
                <input
                  type="radio"
                  name="shipping"
                  value={o.code}
                  checked={o.code === selectedShip?.code}
                  onChange={() => setShipCode(o.code)}
                  className="mt-1 accent-brand-600"
                />
                <span className="flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{o.company}</span>
                    <span className="nums text-sm font-bold">
                      {o.isFree ? labels.free : formatSar(o.feeSar, locale)}
                    </span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                    <span>{o.estimate}</span>
                    {o.hasTracking ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                        {labels.trackable}
                      </span>
                    ) : (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                        {labels.notTrackable}
                      </span>
                    )}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-end gap-3">
        <div>
          <p className="mb-2 text-sm font-medium">{labels.quantity}</p>
          <div className="flex items-center rounded-lg border border-(--color-border-app)">
            <button
              type="button"
              aria-label={labels.decrease}
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="size-11 text-lg hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              −
            </button>
            <span className="nums w-12 text-center text-sm font-medium">{qty}</span>
            <button
              type="button"
              aria-label={labels.increase}
              onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
              className="size-11 text-lg hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              +
            </button>
          </div>
        </div>

        <Button size="lg" className="flex-1" disabled={!canSubmit} onClick={submit}>
          {addToCart.isPending ? labels.adding : labels.addToCart}
        </Button>
      </div>

      <div className="rounded-lg bg-(--color-surface) p-4 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-500">{fill(labels.lineProduct, { n: qty })}</span>
          <span className="nums">
            {formatSar(selectedSku.priceSar * qty, locale)}
          </span>
        </div>
        <div className="mt-1.5 flex justify-between">
          <span className="text-ink-500">{labels.lineShipping}</span>
          <span className="nums">
            {!selectedShip
              ? "—"
              : selectedShip.isFree
                ? labels.free
                : formatSar(selectedShip.feeSar, locale)}
          </span>
        </div>
        <p className="mt-3 border-t border-(--color-border-app) pt-3 text-xs text-ink-500">
          {labels.totalNote}
        </p>
      </div>

      {addToCart.isError && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {addToCart.error.message}
        </p>
      )}
    </div>
  );
}
