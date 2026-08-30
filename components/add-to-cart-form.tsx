"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addToCartAction } from "@/app/actions/cart";
import { Button, cx } from "@/components/ui";
import { formatSar } from "@/lib/pricing";

export interface SkuOption {
  skuAttr: string;
  label: string;
  stock: number;
  priceSar: number;
}

export interface ShippingChoice {
  code: string;
  company: string;
  feeSar: number;
  isFree: boolean;
  hasTracking: boolean;
  estimate: string;
}

export function AddToCartForm({
  aeProductId,
  skus,
  shipping,
}: {
  aeProductId: string;
  skus: SkuOption[];
  shipping: ShippingChoice[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const firstAvailable = skus.find((s) => s.stock > 0) ?? skus[0];
  const [skuAttr, setSkuAttr] = useState(firstAvailable.skuAttr);
  // نفضّل الخيار القابل للتتبع افتراضيًا
  const [shipCode, setShipCode] = useState(
    (shipping.find((s) => s.hasTracking) ?? shipping[0]).code,
  );
  const [qty, setQty] = useState(1);

  const selectedSku = skus.find((s) => s.skuAttr === skuAttr)!;
  const selectedShip = shipping.find((s) => s.code === shipCode)!;
  const maxQty = Math.min(20, Math.max(1, selectedSku.stock));

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await addToCartAction({
        aeProductId,
        skuAttr,
        quantity: qty,
        logisticsServiceName: shipCode,
      });
      if (res.ok) router.push("/cart");
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-6">
      {/* التنويعة */}
      {skus.length > 1 && (
        <div>
          <p className="mb-2 text-sm font-medium">الخيار</p>
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
                      : "border-[--color-border-app] hover:border-brand-400",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-ink-500 nums">
            المتوفّر: {selectedSku.stock} قطعة
          </p>
        </div>
      )}

      {/* خيار الشحن */}
      <div>
        <p className="mb-2 text-sm font-medium">طريقة الشحن</p>
        <div className="space-y-2">
          {shipping.map((o) => (
            <label
              key={o.code}
              className={cx(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition",
                o.code === shipCode
                  ? "border-brand-600 bg-brand-50 dark:bg-brand-900/20"
                  : "border-[--color-border-app] hover:border-brand-400",
              )}
            >
              <input
                type="radio"
                name="shipping"
                value={o.code}
                checked={o.code === shipCode}
                onChange={() => setShipCode(o.code)}
                className="mt-1 accent-brand-600"
              />
              <span className="flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{o.company}</span>
                  <span className="text-sm font-bold nums">
                    {o.isFree ? "مجاني" : formatSar(o.feeSar)}
                  </span>
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                  <span>{o.estimate}</span>
                  {o.hasTracking ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                      قابل للتتبع
                    </span>
                  ) : (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                      بدون تتبع
                    </span>
                  )}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* الكمية والإضافة */}
      <div className="flex items-end gap-3">
        <div>
          <p className="mb-2 text-sm font-medium">الكمية</p>
          <div className="flex items-center rounded-lg border border-[--color-border-app]">
            <button
              type="button"
              aria-label="إنقاص"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="size-11 text-lg hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              −
            </button>
            <span className="w-12 text-center text-sm font-medium nums">{qty}</span>
            <button
              type="button"
              aria-label="زيادة"
              onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
              className="size-11 text-lg hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              +
            </button>
          </div>
        </div>

        <Button
          size="lg"
          className="flex-1"
          disabled={pending || selectedSku.stock === 0}
          onClick={submit}
        >
          {pending ? "جارٍ الإضافة…" : "أضف إلى السلة"}
        </Button>
      </div>

      {/* الإجمالي التقديري */}
      <div className="rounded-lg bg-[--color-surface] p-4 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-500">
            المنتج × <span className="nums">{qty}</span>
          </span>
          <span className="nums">{formatSar(selectedSku.priceSar * qty)}</span>
        </div>
        <div className="mt-1.5 flex justify-between">
          <span className="text-ink-500">الشحن</span>
          <span className="nums">
            {selectedShip.isFree ? "مجاني" : formatSar(selectedShip.feeSar)}
          </span>
        </div>
        <p className="mt-3 border-t border-[--color-border-app] pt-3 text-xs text-ink-500">
          الإجمالي النهائي شاملًا الضريبة يظهر في صفحة السلة.
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
