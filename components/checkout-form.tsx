"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { checkoutAction, type CheckoutState } from "@/app/actions/checkout";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { SAUDI_REGIONS } from "@/lib/ksa";

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

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? "جارٍ تأكيد الطلب…" : "تأكيد الطلب"}
    </Button>
  );
}

export function CheckoutForm({
  isLoggedIn,
  defaults,
}: {
  isLoggedIn: boolean;
  defaults?: Defaults;
}) {
  const [state, formAction] = useActionState<CheckoutState, FormData>(
    checkoutAction,
    {},
  );

  const err = (k: string) => state.errors?.[k];

  return (
    <form action={formAction} className="space-y-5">
      <Card className="p-5">
        <p className="mb-4 font-semibold">عنوان الشحن</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="الاسم الكامل" required error={err("fullName")}>
            <Input
              name="fullName"
              defaultValue={defaults?.fullName}
              autoComplete="name"
              placeholder="الاسم الأول واسم العائلة"
              required
            />
          </Field>

          <Field
            label="رقم الجوال"
            required
            error={err("phone")}
            hint="مثال: 0512345678"
          >
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              dir="ltr"
              className="text-right"
              defaultValue={defaults?.phone}
              autoComplete="tel"
              placeholder="05XXXXXXXX"
              required
            />
          </Field>

          <Field label="المنطقة" required error={err("province")}>
            <Select name="province" defaultValue={defaults?.province ?? ""} required>
              <option value="" disabled>
                اختر المنطقة
              </option>
              {SAUDI_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="المدينة" required error={err("city")}>
            <Input
              name="city"
              defaultValue={defaults?.city}
              autoComplete="address-level2"
              placeholder="الرياض"
              required
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="العنوان التفصيلي"
              required
              error={err("addressLine1")}
              hint="الشارع والحي ورقم المبنى"
            >
              <Input
                name="addressLine1"
                defaultValue={defaults?.addressLine1}
                autoComplete="address-line1"
                placeholder="طريق الملك فهد، حي العليا، مبنى 7"
                required
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label="تفاصيل إضافية" error={err("addressLine2")}>
              <Input
                name="addressLine2"
                defaultValue={defaults?.addressLine2}
                autoComplete="address-line2"
                placeholder="رقم الشقة أو الدور (اختياري)"
              />
            </Field>
          </div>

          <Field label="الرمز البريدي" error={err("postalCode")} hint="خمس خانات">
            <Input
              name="postalCode"
              inputMode="numeric"
              dir="ltr"
              className="text-right"
              defaultValue={defaults?.postalCode}
              autoComplete="postal-code"
              placeholder="12211"
            />
          </Field>

          <Field
            label="العنوان الوطني"
            error={err("nationalAddress")}
            hint="الرمز المختصر: أربعة أحرف وأربعة أرقام (مثال: RRDA2929)"
          >
            <Input
              name="nationalAddress"
              dir="ltr"
              className="text-right uppercase"
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
            حفظ هذا العنوان في حسابي
          </label>
        )}
      </Card>

      <Card className="p-5">
        <Field label="ملاحظات على الطلب">
          <Textarea
            name="notes"
            placeholder="أي تعليمات خاصة بالتوصيل (اختياري)"
            maxLength={300}
          />
        </Field>
      </Card>

      {state.formError && (
        <p className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {state.formError}
        </p>
      )}

      <SubmitButton />

      <p className="text-center text-xs leading-relaxed text-ink-500">
        بتأكيدك الطلب فإنك توافق على مدة الشحن المعروضة أعلاه.
      </p>
    </form>
  );
}
