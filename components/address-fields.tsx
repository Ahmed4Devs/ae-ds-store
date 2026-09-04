"use client";

import { Field, Input, Select } from "@/components/ui";
import { SAUDI_REGIONS } from "@/lib/ksa";
import type { Dictionary } from "@/lib/i18n/shared";

/**
 * مجموعة حقول العنوان السعودي، مشتركة بين إتمام الشراء وإدارة العناوين.
 *
 * الحقول غير مضبوطة (uncontrolled) عمدًا: القيم تُقرأ من FormData عند الإرسال،
 * فلا تُعاد تهيئة الحقل مع كل ضغطة مفتاح. ولأن defaultValue لا يُحدَّث بعد
 * أول رسم، على المستدعي تمرير `key` مختلف عند التبديل بين عنوان وآخر.
 */

/** أسماء الحقول كما تصل إلى مخطّط shippingAddressSchema. */
export interface AddressFieldValues {
  fullName: string;
  phone: string;
  province: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  nationalAddress: string;
}

/**
 * تسميات الحقول تأتي من قسم checkout في القاموس — هي نفسها في الحالتين،
 * ونسخها إلى قسم آخر يعني ترجمتين تفترقان مع الوقت.
 */
export type AddressFieldLabels = Pick<
  Dictionary["checkout"],
  | "fullName"
  | "fullNamePlaceholder"
  | "phone"
  | "phoneHint"
  | "region"
  | "regionPlaceholder"
  | "city"
  | "address1"
  | "address1Hint"
  | "address2"
  | "address2Placeholder"
  | "postalCode"
  | "postalCodeHint"
  | "nationalAddress"
  | "nationalAddressHint"
>;

export function AddressFields({
  values,
  errors,
  labels,
}: {
  values?: Partial<AddressFieldValues>;
  errors?: Record<string, string>;
  labels: AddressFieldLabels;
}) {
  const err = (k: keyof AddressFieldValues) => errors?.[k];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={labels.fullName} required error={err("fullName")}>
        <Input
          name="fullName"
          defaultValue={values?.fullName}
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
          defaultValue={values?.phone}
          autoComplete="tel"
          placeholder="05XXXXXXXX"
          required
        />
      </Field>

      <Field label={labels.region} required error={err("province")}>
        <Select name="province" defaultValue={values?.province ?? ""} required>
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
          defaultValue={values?.city}
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
            defaultValue={values?.addressLine1}
            autoComplete="address-line1"
            required
          />
        </Field>
      </div>

      <div className="sm:col-span-2">
        <Field label={labels.address2} error={err("addressLine2")}>
          <Input
            name="addressLine2"
            defaultValue={values?.addressLine2}
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
          defaultValue={values?.postalCode}
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
          defaultValue={values?.nationalAddress}
          placeholder="RRDA2929"
          maxLength={8}
        />
      </Field>
    </div>
  );
}
