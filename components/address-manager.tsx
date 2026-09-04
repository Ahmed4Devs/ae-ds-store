"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createAddressAction,
  deleteAddressAction,
  setDefaultAddressAction,
  updateAddressAction,
} from "@/app/actions/account";
import {
  AddressFields,
  type AddressFieldLabels,
} from "@/components/address-fields";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { formatSaudiPhone } from "@/lib/ksa";
import type { Dictionary } from "@/lib/i18n/shared";

/**
 * دفتر عناوين العميل: عرض وإضافة وتعديل وحذف وتعيين الافتراضي.
 *
 * التحقّق كامل على الخادم داخل app/actions/account.ts. ما هنا واجهة فقط:
 * أي فحص نضيفه هنا زينة يمكن تجاوزها بطلب POST مباشر.
 */

/** ما تحتاجه البطاقة من صف العنوان — لا نمرّر كائن Prisma كاملًا إلى العميل. */
export interface AddressListItem {
  id: string;
  fullName: string;
  phone: string;
  province: string;
  city: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string | null;
  nationalAddr: string | null;
  isDefault: boolean;
}

type AccountLabels = Dictionary["account"];
type CommonLabels = Pick<
  Dictionary["common"],
  "save" | "cancel" | "saving" | "edit" | "delete"
>;

/** لا شيء مفتوح، أو نموذج إضافة، أو نموذج تعديل عنوان بعينه. */
type Editing = null | { id: null } | { id: string };

/**
 * الهاتف مخزَّن مطبَّعًا (تسع خانات تبدأ بـ 5)، والعميل يعرف رقمه بصيغة 05…
 * فنعيده إلى الصيغة المألوفة داخل الحقل؛ المخطّط يطبّعه مرة أخرى عند الحفظ.
 */
function phoneForInput(phone: string): string {
  return /^5\d{8}$/.test(phone) ? `0${phone}` : phone;
}

export function AddressManager({
  addresses,
  labels,
  fieldLabels,
  common,
}: {
  addresses: AddressListItem[];
  labels: AccountLabels;
  fieldLabels: AddressFieldLabels;
  common: CommonLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Editing>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const current =
    editing && editing.id
      ? addresses.find((a) => a.id === editing.id) ?? null
      : null;

  function close() {
    setEditing(null);
    setErrors({});
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;

    const fd = new FormData(e.currentTarget);
    const input = {
      fullName: String(fd.get("fullName") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      province: String(fd.get("province") ?? ""),
      city: String(fd.get("city") ?? ""),
      addressLine1: String(fd.get("addressLine1") ?? ""),
      addressLine2: String(fd.get("addressLine2") ?? ""),
      postalCode: String(fd.get("postalCode") ?? ""),
      nationalAddress: String(fd.get("nationalAddress") ?? ""),
    };

    const id = editing.id;

    startTransition(async () => {
      const res = id
        ? await updateAddressAction({ id, ...input })
        : await createAddressAction(input);

      if (!res.ok) {
        setErrors(res.errors ?? {});
        setNotice(
          res.message ? { ok: false, text: res.message } : null,
        );
        return;
      }

      setErrors({});
      setNotice({ ok: true, text: labels.addressSaved });
      setEditing(null);
      router.refresh();
    });
  }

  function onDelete(id: string) {
    // تأكيد بسيط عبر المتصفح — يكفي هنا، والحذف غير مدمّر أصلًا: الطلبيات
    // السابقة تحتفظ بلقطة عنوانها (Order.addressId = SetNull).
    if (!window.confirm(labels.deleteAddressConfirm)) return;

    startTransition(async () => {
      const res = await deleteAddressAction({ id });
      setNotice(
        res.ok
          ? { ok: true, text: labels.addressDeleted }
          : { ok: false, text: res.message ?? labels.addressFailed },
      );
      if (res.ok && editing && editing.id === id) close();
      router.refresh();
    });
  }

  function onSetDefault(id: string) {
    startTransition(async () => {
      const res = await setDefaultAddressAction({ id });
      if (!res.ok) {
        setNotice({ ok: false, text: res.message ?? labels.addressFailed });
        return;
      }
      setNotice(null);
      router.refresh();
    });
  }

  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[--color-border-app] px-5 py-3">
        <p className="font-semibold">{labels.manageAddresses}</p>
        {!editing && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setErrors({});
              setNotice(null);
              setEditing({ id: null });
            }}
          >
            {labels.addAddress}
          </Button>
        )}
      </div>

      {notice && (
        <p
          className={
            "border-b border-[--color-border-app] px-5 py-3 text-sm leading-relaxed " +
            (notice.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400")
          }
        >
          {notice.text}
        </p>
      )}

      {editing && (
        <form
          onSubmit={onSubmit}
          className="border-b border-[--color-border-app] p-5"
          /**
           * حقول غير مضبوطة: defaultValue لا يُقرأ إلا عند أول رسم، فبدون
           * مفتاح مختلف لكل عنوان يبقى النموذج معبّأً ببيانات العنوان السابق.
           */
          key={current?.id ?? "new"}
        >
          <p className="mb-4 font-semibold">
            {current ? labels.editAddress : labels.addAddress}
          </p>

          <AddressFields
            labels={fieldLabels}
            errors={errors}
            values={
              current
                ? {
                    fullName: current.fullName,
                    phone: phoneForInput(current.phone),
                    province: current.province,
                    city: current.city,
                    addressLine1: current.addressLine1,
                    addressLine2: current.addressLine2 ?? "",
                    postalCode: current.postalCode ?? "",
                    nationalAddress: current.nationalAddr ?? "",
                  }
                : undefined
            }
          />

          <div className="mt-5 flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? common.saving : common.save}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={close}
            >
              {common.cancel}
            </Button>
          </div>
        </form>
      )}

      {addresses.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title={labels.noAddresses}
            description={labels.noAddressesBody}
          />
        </div>
      ) : (
        <ul className="divide-y divide-[--color-border-app]">
          {addresses.map((a) => (
            <li key={a.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="text-sm leading-relaxed">
                  <p className="font-medium">
                    {a.fullName}
                    {a.isDefault && (
                      <Badge tone="success" className="ms-2">
                        {labels.defaultBadge}
                      </Badge>
                    )}
                  </p>
                  <p className="text-ink-500 nums" dir="ltr">
                    {formatSaudiPhone(a.phone)}
                  </p>
                  <p className="text-ink-500">
                    {a.addressLine1}
                    {a.addressLine2 ? `، ${a.addressLine2}` : ""}، {a.city}،{" "}
                    {a.province}
                  </p>
                  {a.postalCode && (
                    <p className="text-xs text-ink-500 nums">{a.postalCode}</p>
                  )}
                  {a.nationalAddr && (
                    <p className="text-xs text-ink-500 nums">
                      {labels.nationalAddressLabel}: {a.nationalAddr}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {!a.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => onSetDefault(a.id)}
                    >
                      {labels.setDefault}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setErrors({});
                      setNotice(null);
                      setEditing({ id: a.id });
                    }}
                  >
                    {common.edit}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    onClick={() => onDelete(a.id)}
                  >
                    {common.delete}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {addresses.length > 0 && (
        <p className="border-t border-[--color-border-app] px-5 py-3 text-xs leading-relaxed text-ink-500">
          {labels.addressInUse}
        </p>
      )}
    </Card>
  );
}
