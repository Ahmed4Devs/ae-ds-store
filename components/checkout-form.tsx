"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { checkoutAction, type CheckoutState } from "@/app/actions/checkout";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { SAUDI_REGIONS } from "@/lib/ksa";
import type { Dictionary } from "@/lib/i18n/shared";

interface Defaults {
  fullName: string;
  phone: string;
  province: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  nationalAddress: string;
}

type Labels = Dictionary["checkout"];

function SubmitButton({ labels }: { labels: Labels }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? labels.submitting : labels.submit}
    </Button>
  );
}

export function CheckoutForm({
  isLoggedIn,
  defaults,
  labels,
  checkoutToken,
}: {
  isLoggedIn: boolean;
  defaults?: Defaults;
  labels: Labels;
  checkoutToken: string;
}) {
  const [state, formAction] = useActionState<CheckoutState, FormData>(
    checkoutAction,
    {},
  );

  const err = (k: string) => state.errors?.[k];

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="checkoutToken" value={checkoutToken} />
      <Card className="p-5">
        <p className="mb-4 font-semibold">{labels.shippingAddress}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={labels.fullName} required error={err("fullName")}>
            <Input
              name="fullName"
              defaultValue={defaults?.fullName}
              autoComplete="name"
              placeholder={labels.fullNamePlaceholder}
              required
            />
          </Field>

          <Field
            label={labels.phone}
            required
            error={err("phone")}
            hint={labels.phoneHint}
          >
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              dir="ltr"
              defaultValue={defaults?.phone}
              autoComplete="tel"
              placeholder="05XXXXXXXX"
              required
            />
          </Field>

          <Field label={labels.region} required error={err("province")}>
            <Select name="province" defaultValue={defaults?.province ?? ""} required>
              <option value="" disabled>
                {labels.regionPlaceholder}
              </option>
              {SAUDI_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={labels.city} required error={err("city")}>
            <Input
              name="city"
              defaultValue={defaults?.city}
              autoComplete="address-level2"
              required
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label={labels.address1}
              required
              error={err("addressLine1")}
              hint={labels.address1Hint}
            >
              <Input
                name="addressLine1"
                defaultValue={defaults?.addressLine1}
                autoComplete="address-line1"
                required
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label={labels.address2} error={err("addressLine2")}>
              <Input
                name="addressLine2"
                defaultValue={defaults?.addressLine2}
                autoComplete="address-line2"
                placeholder={labels.address2Placeholder}
              />
            </Field>
          </div>

          <Field
            label={labels.postalCode}
            error={err("postalCode")}
            hint={labels.postalCodeHint}
          >
            <Input
              name="postalCode"
              inputMode="numeric"
              dir="ltr"
              defaultValue={defaults?.postalCode}
              autoComplete="postal-code"
              placeholder="12211"
            />
          </Field>

          <Field
            label={labels.nationalAddress}
            error={err("nationalAddress")}
            hint={labels.nationalAddressHint}
          >
            <Input
              name="nationalAddress"
              dir="ltr"
              className="uppercase"
              defaultValue={defaults?.nationalAddress}
              placeholder="RRDA2929"
              maxLength={8}
            />
          </Field>
        </div>

        {isLoggedIn && (
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="saveAddress"
              defaultChecked
              className="size-4 accent-brand-600"
            />
            {labels.saveAddress}
          </label>
        )}
      </Card>

      <Card className="p-5">
        <Field label={labels.notes}>
          <Textarea
            name="notes"
            placeholder={labels.notesPlaceholder}
            maxLength={300}
          />
        </Field>
      </Card>

      {state.formError && (
        <p className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {state.formError}
        </p>
      )}

      <SubmitButton labels={labels} />

      <p className="text-center text-xs leading-relaxed text-ink-500">
        {labels.terms}
      </p>
    </form>
  );
}
