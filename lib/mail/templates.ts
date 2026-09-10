import { prisma } from "@/lib/db";
import { after } from "next/server";
import { env } from "@/lib/env";
import { formatSar } from "@/lib/pricing";
import {
  DEFAULT_LOCALE,
  dictionaries,
  dirFor,
  fill,
  isLocale,
  LOCALE_COOKIE,
  type Locale,
} from "@/lib/i18n/shared";
import { deliver, type MailMessage } from "@/lib/mail/providers";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * يربط النقل بعمر طلب Next عبر after/waitUntil. إطلاق Promise عارية قد
 * يقطعه الخادم serverless بعد إرسال الاستجابة وقبل وصول البريد.
 */
async function scheduleAuthMail(
  message: MailMessage,
  kind: string,
): Promise<void> {
  const send = async () => {
    try {
      await deliver(message);
    } catch (error) {
      // لا نطبع كائن المزوّد؛ قد يحمل عنوان المستلم أو محتوى الرسالة.
      console.error(
        `[mail] ${kind} delivery failed`,
        safeErrorKind(error),
      );
    }
  };

  try {
    after(send);
  } catch {
    // Better Auth can also be called from jobs, scripts, and integration tests
    // where there is no Next request/prerender context. In that case `after`
    // throws synchronously; awaiting delivery is the only lifecycle-safe path.
    // Delivery failures remain normalized inside `send` so callers cannot use
    // provider timing/errors as an account-existence oracle.
    await send();
  }
}

/**
 * قوالب البريد ورسائل الطلبيات.
 *
 * قاعدة حاكمة في تصميم القالب: عميل البريد ليس متصفّحًا. كثير منها يُسقط
 * وسم <style> كاملًا، ولا يدعم flex ولا grid، ويتجاهل الفئات. لذلك التخطيط
 * هنا جداول وأنماط سطرية فقط، والألوان بقيم صريحة لا برموز التصميم —
 * فرموزنا معرَّفة في CSS المتجر ولا تصل صندوق البريد إطلاقًا.
 */

/** لون العلامة كما في ‎--color-brand-600؛ مكتوب صراحةً لأن الرمز لا يصل البريد. */
const BRAND = "#059669";
const INK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";
const SURFACE = "#ffffff";
const BACKDROP = "#f3f4f6";

/**
 * يُهرِّب كل قيمة تُحقن في HTML.
 * اسم عميل يحوي «<» يكسر الوسوم ويحوّل الرسالة إلى ناقل لشيفرة غريبة.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderMailOptions {
  locale: Locale;
  heading: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footNote?: string;
}

/**
 * يبني نسختي الرسالة: HTML للعرض ونصًّا صرفًا للعملاء التي ترفض HTML
 * (ولمرشّحات السخام التي تخفض تقييم رسالة بلا نسخة نصية).
 */
export function renderMail(opts: RenderMailOptions): {
  html: string;
  text: string;
} {
  const t = dictionaries[opts.locale];
  const dir = dirFor(opts.locale);
  const align = dir === "rtl" ? "right" : "left";
  const signature = fill(t.mail.signature, { store: t.meta.siteName });

  // الجسم يُقسَّم على الأسطر إلى فقرات: هكذا تمرّر الرسائل قائمة عناصر
  // الطلبية نصًّا واحدًا دون أن تفتح ثغرة حقن HTML
  const paragraphs = opts.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const paragraphsHtml = paragraphs
    .map(
      (line) =>
        `<p style="margin:0 0 12px;font-size:15px;line-height:1.8;color:${INK};">${escapeHtml(line)}</p>`,
    )
    .join("");

  /**
   * زر «مضاد للرصاص»: خلية جدول ملوّنة بداخلها رابط بحشوة كاملة، لا زر
   * CSS. أوتلوك يتجاهل padding على <a> وحده فيتقلّص الزر إلى نص عارٍ.
   */
  const ctaHtml =
    opts.ctaUrl && opts.ctaLabel
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
              <tr>
                <td bgcolor="${BRAND}" style="border-radius:8px;">
                  <a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;mso-padding-alt:12px 28px;">${escapeHtml(opts.ctaLabel)}</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 6px;font-size:12px;color:${MUTED};">${escapeHtml(t.mail.linkFallback)}</p>
            <p style="margin:0 0 16px;font-size:12px;line-height:1.6;word-break:break-all;" dir="ltr"><a href="${escapeHtml(opts.ctaUrl)}" style="color:${BRAND};">${escapeHtml(opts.ctaUrl)}</a></p>`
      : "";

  const footNoteHtml = opts.footNote
    ? `<p style="margin:0 0 8px;font-size:12px;line-height:1.7;color:${MUTED};">${escapeHtml(opts.footNote)}</p>`
    : "";

  const html = `<!doctype html>
<html dir="${dir}" lang="${opts.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BACKDROP};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BACKDROP};padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:${SURFACE};border:1px solid ${BORDER};border-radius:12px;">
        <tr>
          <td align="${align}" style="padding:24px 24px 8px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
            <p style="margin:0;font-size:14px;font-weight:bold;color:${BRAND};">${escapeHtml(t.meta.siteName)}</p>
          </td>
        </tr>
        <tr>
          <td align="${align}" style="padding:0 24px 24px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
            <h1 style="margin:0 0 16px;font-size:20px;line-height:1.5;color:${INK};">${escapeHtml(opts.heading)}</h1>
            ${paragraphsHtml}
            ${ctaHtml}
            <hr style="border:none;border-top:1px solid ${BORDER};margin:20px 0;">
            ${footNoteHtml}
            <p style="margin:0;font-size:12px;color:${MUTED};">${escapeHtml(signature)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const textParts = [opts.heading, "", ...paragraphs];
  if (opts.ctaUrl && opts.ctaLabel) {
    textParts.push("", `${opts.ctaLabel}: ${opts.ctaUrl}`);
  }
  textParts.push("", "—");
  if (opts.footNote) textParts.push(opts.footNote);
  textParts.push(signature);

  return { html, text: textParts.join("\n") };
}

/**
 * لغة المستلم من كوكي اللغة في الطلب.
 * القراءة من الترويسة مباشرة لا من next/headers: هذه الوحدة تُستدعى أيضًا
 * من مهام خلفية لا طلب لها، واستيراد next/headers هناك يرمي.
 */
export function localeFromRequest(request?: Request): Locale {
  const cookie = request?.headers.get("cookie");
  if (!cookie) return DEFAULT_LOCALE;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  const raw = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/** رابط مطلق داخل المتجر — الرسالة تُقرأ خارج المتصفّح فلا تنفع المسارات النسبية. */
function storeUrl(path: string): string {
  return `${env().STORE_PUBLIC_URL.replace(/\/$/, "")}${path}`;
}

// ------------------------------------------------------------ رسائل المصادقة

/**
 * رسالة إعادة تعيين كلمة المرور.
 *
 * الرابط يصل جاهزًا من better-auth وهو مبنيّ على BETTER_AUTH_URL لا على
 * STORE_PUBLIC_URL — لأن الرمز يُستهلك في ‎/api/auth‎ قبل التحويل إلى صفحة
 * التعيين. فإن اختلف العنوانان وجب ضبط BETTER_AUTH_URL على العنوان العام
 * لا على المضيف الداخلي، وإلا وصل العميل رابطًا لا يفتح من الخارج.
 */
export async function sendPasswordResetMail(opts: {
  to: string;
  name: string;
  url: string;
  locale: Locale;
}): Promise<void> {
  const t = dictionaries[opts.locale];
  try {
    const { html, text } = renderMail({
      locale: opts.locale,
      heading: t.auth.resetTitle,
      body: `${fill(t.mail.greeting, { name: opts.name })}\n${t.mail.resetBody}`,
      ctaLabel: t.mail.resetCta,
      ctaUrl: opts.url,
      footNote: t.mail.ignoreNote,
    });
    // يُجدول بعد الرد لمنع عرّاف توقيت كشف الحساب، مع إبقاء serverless حيًا.
    await scheduleAuthMail(
      {
        to: opts.to,
        subject: fill(t.mail.resetSubject, { store: t.meta.siteName }),
        html,
        text,
      },
      "password reset",
    );
  } catch (error) {
    console.error(
      "[mail] password reset render failed",
      safeErrorKind(error),
    );
  }
}

/** رسالة تأكيد البريد. */
export async function sendEmailVerificationMail(opts: {
  to: string;
  name: string;
  url: string;
  locale: Locale;
}): Promise<void> {
  const t = dictionaries[opts.locale];
  try {
    const { html, text } = renderMail({
      locale: opts.locale,
      heading: t.auth.verifyTitle,
      body: `${fill(t.mail.greeting, { name: opts.name })}\n${t.mail.verifyBody}`,
      ctaLabel: t.mail.verifyCta,
      ctaUrl: opts.url,
      footNote: t.mail.ignoreNote,
    });
    // كسابقتها: after يمنع فرق التوقيت ولا يفقد المهمة في serverless.
    await scheduleAuthMail(
      {
        to: opts.to,
        subject: fill(t.mail.verifySubject, { store: t.meta.siteName }),
        html,
        text,
      },
      "verification",
    );
  } catch (error) {
    console.error(
      "[mail] verification render failed",
      safeErrorKind(error),
    );
  }
}

// ------------------------------------------------------------ رسائل الطلبيات

/**
 * تحميل الطلبية مع عناصرها وصاحبها.
 *
 * لغة الرسالة هي DEFAULT_LOCALE دائمًا: جدول Order لا يحمل عمود لغة، ولا
 * سبيل لمعرفة لغة العميل وقت الإرسال (المهام المجدولة ترسل بلا طلب أصلًا).
 * تخمين اللغة من مصدر آخر يعطي نتيجة عشوائية، والافتراضي أصدق.
 */
async function loadOrderForMail(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, user: true },
  });
}

/** سطور العناصر كنصّ — تُمرَّر ضمن الجسم فتُهرَّب مع بقيته. */
function itemLines(
  items: Array<{
    quantity: number;
    titleSnapshot: string;
    variantLabel: string | null;
  }>,
): string {
  return items
    .map(
      (i) =>
        `• ${i.quantity} × ${i.titleSnapshot}${i.variantLabel ? ` — ${i.variantLabel}` : ""}`,
    )
    .join("\n");
}

/** رسالة «استلمنا طلبك» — تُرسَل بعد نجاح الدفع. */
export async function sendOrderPlacedMail(orderId: string): Promise<void> {
  try {
    const order = await loadOrderForMail(orderId);
    // طلبية الضيف قد لا تحمل بريدًا أصلًا — ليس خطأ، ببساطة لا مرسَل إليه
    if (!order?.user?.email) return;

    const locale = DEFAULT_LOCALE;
    const t = dictionaries[locale];
    // Decimal لا يُحسب ولا يُقارن قبل Number()
    const total = formatSar(Number(order.totalSar), locale);
    const subject = fill(t.mail.orderPlacedSubject, {
      orderNumber: order.orderNumber,
    });

    const { html, text } = renderMail({
      locale,
      heading: subject,
      body: [
        fill(t.mail.greeting, { name: order.user.name }),
        fill(t.mail.orderPlacedBody, { total }),
        itemLines(order.items),
      ]
        .filter((line) => line !== "")
        .join("\n"),
      ctaLabel: t.mail.orderPlacedCta,
      ctaUrl: storeUrl(`/orders/${order.orderNumber}`),
    });

    await deliver({ to: order.user.email, subject, html, text });
  } catch (error) {
    // انقطاع البريد يجب ألا يُفشل طلبية دُفعت بالفعل
    console.error(
      "[mail] order placed delivery failed",
      safeErrorKind(error),
    );
  }
}

/** رسالة «شُحن طلبك». */
export async function sendOrderShippedMail(orderId: string): Promise<void> {
  try {
    const order = await loadOrderForMail(orderId);
    if (!order?.user?.email) return;

    const locale = DEFAULT_LOCALE;
    const t = dictionaries[locale];
    const subject = fill(t.mail.orderShippedSubject, {
      orderNumber: order.orderNumber,
    });

    const { html, text } = renderMail({
      locale,
      heading: subject,
      body: [
        fill(t.mail.greeting, { name: order.user.name }),
        t.mail.orderShippedBody,
      ].join("\n"),
      ctaLabel: t.mail.orderShippedCta,
      ctaUrl: storeUrl(`/orders/${order.orderNumber}`),
    });

    await deliver({ to: order.user.email, subject, html, text });
  } catch (error) {
    console.error(
      "[mail] order shipped delivery failed",
      safeErrorKind(error),
    );
  }
}

/** رسالة «أُلغي طلبك». */
export async function sendOrderCancelledMail(orderId: string): Promise<void> {
  try {
    const order = await loadOrderForMail(orderId);
    if (!order?.user?.email) return;

    const locale = DEFAULT_LOCALE;
    const t = dictionaries[locale];
    const subject = fill(t.mail.orderCancelledSubject, {
      orderNumber: order.orderNumber,
    });

    const { html, text } = renderMail({
      locale,
      heading: subject,
      body: [
        fill(t.mail.greeting, { name: order.user.name }),
        t.mail.orderCancelledBody,
      ].join("\n"),
      ctaLabel: t.mail.orderCancelledCta,
      ctaUrl: storeUrl(`/orders/${order.orderNumber}`),
    });

    await deliver({ to: order.user.email, subject, html, text });
  } catch (error) {
    console.error(
      "[mail] order cancelled delivery failed",
      safeErrorKind(error),
    );
  }
}

/** رسالة لا تُرسل إلا بعد تأكيد المزوّد اكتمال full refund. */
export async function sendOrderRefundedMail(orderId: string): Promise<void> {
  try {
    const order = await loadOrderForMail(orderId);
    if (!order?.user?.email) return;

    const locale = DEFAULT_LOCALE;
    const t = dictionaries[locale];
    const subject = fill(t.mail.orderRefundedSubject, {
      orderNumber: order.orderNumber,
    });
    const { html, text } = renderMail({
      locale,
      heading: subject,
      body: [
        fill(t.mail.greeting, { name: order.user.name }),
        t.mail.orderRefundedBody,
      ].join("\n"),
      ctaLabel: t.mail.orderRefundedCta,
      ctaUrl: storeUrl(`/orders/${order.orderNumber}`),
    });
    await deliver({ to: order.user.email, subject, html, text });
  } catch (error) {
    console.error(
      "[mail] order refunded delivery failed",
      safeErrorKind(error),
    );
  }
}

export type { MailMessage };
