"use client";

import { Alert, Button, Card } from "@/components/ui";
import { formatSar } from "@/lib/pricing";
import { formatDateAr, formatSaudiPhone } from "@/lib/ksa";
import type { ShippingAddress } from "@/lib/ksa";
import { fill, type Dictionary, type Locale } from "@/lib/i18n/shared";

/**
 * الفاتورة الضريبية المبسّطة — مستند قابل للطباعة.
 *
 * المكوّن عميل بالكامل لسبب واحد: زرّ الطباعة يحتاج `window.print()`، ولا
 * يحمل مكوّن الخادم onClick. كل ما يعرضه يصله جاهزًا من الصفحة (أرقام
 * ونصوص) فلا يستدعي قاعدة بيانات ولا يقرأ متغيّرات بيئة.
 *
 * قواعد الطباعة محصورة في وسم <style> داخل المكوّن بدل globals.css: الملف
 * العام يخصّ المتجر كلّه، وإقحام قواعد @media print خاصة بصفحة واحدة فيه
 * يجعلها تسري على كل صفحة يُطبع منها شيء لاحقًا.
 */

/** بند واحد في الفاتورة — لقطة وقت الطلب لا حالة المنتج اليوم. */
export interface InvoiceLine {
  id: string;
  title: string;
  variantLabel: string | null;
  quantity: number;
  unitPriceSar: number;
}

export interface InvoiceViewProps {
  locale: Locale;
  labels: Dictionary["invoice"];
  /** رقم الفاتورة = رقم الطلبية الظاهر للعميل. */
  invoiceNumber: string;
  /** تاريخ الإصدار بصيغة ISO — التحويل إلى نص محلّي يتم هنا. */
  issuedAtIso: string;
  sellerName: string;
  vatNumber: string;
  crNumber: string;
  buyerName: string | null;
  address: ShippingAddress;
  lines: InvoiceLine[];
  subtotalSar: number;
  shippingSar: number;
  vatSar: number;
  totalSar: number;
  vatPercent: number;
  /**
   * صورة رمز ZATCA بصيغة data URL، أو null حين يكون الرقم الضريبي غير
   * مضبوط — عندئذٍ نعرض تحذيرًا مكانه بدل رمز يحمل حقلًا فارغًا.
   */
  qrDataUrl: string | null;
}

/**
 * قواعد الطباعة.
 *
 * إخفاء كل أبناء body عدا <main> يزيل الشريط الإعلاني والترويسة والتذييل
 * دفعةً واحدة، وهو أمتن من تعداد عناصر الهيكل بالاسم لأن أي عنصر جديد
 * يُضاف إلى التخطيط لاحقًا يُستبعد تلقائيًا بدل أن يظهر فجأةً في الورق.
 * والألوان تُقسر على أسود على أبيض لأن الوضع الداكن يطبع صفحة سوداء
 * تلتهم الحبر وتخرج بنصّ باهت.
 */
const PRINT_CSS = `
@media print {
  @page { margin: 15mm; }

  html, body {
    background: #fff !important;
    color: #000 !important;
  }

  body > *:not(main) { display: none !important; }
  .no-print { display: none !important; }

  main { padding: 0 !important; }

  .invoice-doc, .invoice-doc * {
    color: #000 !important;
    background: transparent !important;
    box-shadow: none !important;
  }

  .invoice-doc .inv-sheet {
    border: 0 !important;
    border-radius: 0 !important;
    padding: 0 !important;
    max-width: none !important;
  }

  .invoice-doc .inv-rule,
  .invoice-doc .inv-table th,
  .invoice-doc .inv-table td,
  .invoice-doc .inv-box {
    border-color: #9a9a9a !important;
  }

  .invoice-doc .inv-note { color: #444 !important; }

  /* الجدول لا يُشطر بين ورقتين إن أمكن — بند مقطوع نصفين يربك القارئ */
  .invoice-doc .inv-table tr { page-break-inside: avoid; }
  .invoice-doc .inv-totals { page-break-inside: avoid; }
  .invoice-doc .inv-qr { page-break-inside: avoid; }
}
`;

export function InvoiceView({
  locale,
  labels,
  invoiceNumber,
  issuedAtIso,
  sellerName,
  vatNumber,
  crNumber,
  buyerName,
  address,
  lines,
  subtotalSar,
  shippingSar,
  vatSar,
  totalSar,
  vatPercent,
  qrDataUrl,
}: InvoiceViewProps) {
  return (
    <div className="invoice-doc mx-auto w-full max-w-3xl">
      <style>{PRINT_CSS}</style>

      <div className="no-print mb-5 flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
          {labels.print}
        </Button>
      </div>

      <Card className="inv-sheet p-6 sm:p-8">
        {/* ترويسة المستند */}
        <div className="inv-rule mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-[--color-border-app] pb-5">
          <div>
            <h1 className="text-xl font-bold">{labels.heading}</h1>
            <p className="inv-note mt-1 text-xs text-ink-500">{labels.currencyNote}</p>
          </div>
          <dl className="text-sm">
            <div className="flex gap-2">
              <dt className="inv-note text-ink-500">{labels.number}:</dt>
              <dd className="nums font-semibold" dir="ltr">
                {invoiceNumber}
              </dd>
            </div>
            <div className="mt-1 flex gap-2">
              <dt className="inv-note text-ink-500">{labels.issuedAt}:</dt>
              <dd className="nums">{formatDateAr(issuedAtIso, locale)}</dd>
            </div>
          </dl>
        </div>

        {/* البائع والعميل */}
        <div className="mb-6 grid gap-5 sm:grid-cols-2">
          <section>
            <h2 className="inv-note mb-2 text-xs font-semibold uppercase text-ink-500">
              {labels.seller}
            </h2>
            <p className="font-medium">{sellerName}</p>
            <p className="mt-1 text-sm">
              <span className="inv-note text-ink-500">{labels.sellerVat}: </span>
              <span className="nums" dir="ltr">
                {vatNumber || "—"}
              </span>
            </p>
            {crNumber && (
              <p className="mt-0.5 text-sm">
                <span className="inv-note text-ink-500">{labels.sellerCr}: </span>
                <span className="nums" dir="ltr">
                  {crNumber}
                </span>
              </p>
            )}
          </section>

          <section>
            <h2 className="inv-note mb-2 text-xs font-semibold uppercase text-ink-500">
              {labels.buyer}
            </h2>
            {/* الفاتورة المبسّطة لا تُلزم ببيانات المشتري، فاسم الشحن يكفي */}
            <p className="font-medium">{buyerName || labels.buyerGuest}</p>
            <p className="nums mt-1 text-sm" dir="ltr">
              {formatSaudiPhone(address.phone)}
            </p>
          </section>
        </div>

        {/* عنوان الشحن */}
        <section className="inv-box mb-6 rounded-lg border border-[--color-border-app] p-4">
          <h2 className="inv-note mb-2 text-xs font-semibold uppercase text-ink-500">
            {labels.shipTo}
          </h2>
          <address className="space-y-0.5 text-sm not-italic leading-relaxed">
            <p>{address.addressLine1}</p>
            {address.addressLine2 && <p>{address.addressLine2}</p>}
            <p>
              {address.city}
              {locale === "ar" ? "، " : ", "}
              {address.province}
              {address.postalCode && <span className="nums"> {address.postalCode}</span>}
            </p>
          </address>
        </section>

        {/* البنود */}
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{labels.items}</h2>
          <div className="overflow-x-auto">
            <table className="inv-table w-full min-w-[28rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[--color-border-app] text-start">
                  <th className="py-2 pe-3 text-start font-semibold">
                    {labels.colDescription}
                  </th>
                  <th className="w-16 py-2 px-3 text-center font-semibold">
                    {labels.colQty}
                  </th>
                  <th className="w-32 py-2 px-3 text-end font-semibold">
                    {labels.colUnitPrice}
                  </th>
                  <th className="w-32 py-2 ps-3 text-end font-semibold">
                    {labels.colLineTotal}
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b border-[--color-border-app]">
                    <td className="py-2.5 pe-3 align-top">
                      <span>{line.title}</span>
                      {line.variantLabel && (
                        <span className="inv-note block text-xs text-ink-500">
                          {line.variantLabel}
                        </span>
                      )}
                    </td>
                    <td className="nums py-2.5 px-3 text-center align-top">
                      {line.quantity}
                    </td>
                    <td className="nums py-2.5 px-3 text-end align-top">
                      {formatSar(line.unitPriceSar, locale)}
                    </td>
                    <td className="nums py-2.5 ps-3 text-end align-top font-medium">
                      {formatSar(line.unitPriceSar * line.quantity, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* الإجماليات */}
        <section className="inv-totals mb-6 flex justify-end">
          <dl className="w-full max-w-xs space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="inv-note text-ink-500">{labels.subtotal}</dt>
              <dd className="nums">{formatSar(subtotalSar, locale)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="inv-note text-ink-500">{labels.shipping}</dt>
              <dd className="nums">{formatSar(shippingSar, locale)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="inv-note text-ink-500">
                {fill(labels.vat, { n: vatPercent })}
              </dt>
              <dd className="nums">{formatSar(vatSar, locale)}</dd>
            </div>
            <div className="inv-rule flex justify-between border-t border-[--color-border-app] pt-2 text-base font-bold">
              <dt>{labels.total}</dt>
              <dd className="nums">{formatSar(totalSar, locale)}</dd>
            </div>
          </dl>
        </section>

        {/* رمز الاستجابة السريعة أو تحذير غياب الرقم الضريبي */}
        <section className="inv-qr inv-rule border-t border-[--color-border-app] pt-5">
          {qrDataUrl ? (
            <div className="flex flex-wrap items-center gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                alt={labels.qrTitle}
                width={140}
                height={140}
                className="shrink-0 rounded bg-white p-1"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{labels.qrTitle}</p>
                <p className="inv-note mt-1 max-w-md text-xs leading-relaxed text-ink-500">
                  {labels.qrNote}
                </p>
              </div>
            </div>
          ) : (
            <Alert tone="warning" title={labels.missingVatTitle}>
              {labels.missingVatBody}
            </Alert>
          )}
        </section>

        <p className="inv-note mt-6 text-xs leading-relaxed text-ink-500">
          {labels.footerNote}
        </p>
      </Card>
    </div>
  );
}
