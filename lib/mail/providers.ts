import { env } from "@/lib/env";

/**
 * مُرسِلات البريد — ثلاثة مزوّدين خلف دالة واحدة.
 *
 * الفصل عن القوالب مقصود: القالب يبني النص، والمزوّد ينقله فقط. هكذا
 * يبقى تبديل المزوّد (console ← smtp ← resend) تغييرًا في البيئة لا في
 * الشيفرة، ولا يتسرّب أي اعتماد خاص بالنقل إلى بقية المتجر.
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** عنوان المُرسِل بصيغة "الاسم <العنوان>" متى ضُبط الاسم. */
function fromAddress(): string {
  const address = env().MAIL_FROM;
  // إزالة محارف الأسطر مع الاقتباس: سطرٌ جديد في اسم المُرسِل يحقن ترويسات
  // بريد إضافية (Bcc خفيّ مثلًا). الاسم من البيئة لا من المستخدم، لكن
  // التنظيف هنا حاجزٌ رخيص ضد تهيئة خاطئة.
  const name = env()
    .MAIL_FROM_NAME.trim()
    .replace(/[\r\n"]/g, "");
  if (!name) return address;
  return `"${name}" <${address}>`;
}

/** مهلة نقل البريد بالمللي ثانية — مزوّد بطيء يجب ألّا يعلّق مسار المصادقة. */
const MAIL_TIMEOUT_MS = 10_000;

/**
 * مزوّد التطوير: يطبع الرسالة في الطرفية.
 *
 * يُطبع الرابط كاملًا عمدًا — في التطوير لا يوجد صندوق بريد يستقبل
 * رسالة الاستعادة أو التأكيد، فلو طُبع النص مقصوصًا لتعذّر على المطوّر
 * إكمال المسار أصلًا. النقر على الرابط من الطرفية هو طريقة الاختبار
 * الوحيدة هنا.
 */
function sendViaConsole(msg: MailMessage): void {
  const urls = msg.text.match(/https?:\/\/\S+/g) ?? [];
  const lines = [
    "──────────────────────────────────────────────",
    "  MAIL (console provider — not actually sent)",
    `  from:    ${fromAddress()}`,
    `  to:      ${msg.to}`,
    `  subject: ${msg.subject}`,
    "──────────────────────────────────────────────",
    msg.text,
  ];
  if (urls.length > 0) {
    lines.push("──────────────────────────────────────────────");
    for (const url of urls) lines.push(`  🔗 ${url}`);
  }
  lines.push("──────────────────────────────────────────────");
  console.log(lines.join("\n"));
}

/**
 * SMTP عبر nodemailer.
 *
 * الاستيراد ديناميكي لا ساكن: nodemailer حزمة Node خالصة، ولو استُوردت
 * في أعلى الوحدة لسُحبت إلى أي حزمة تستورد lib/mail — بما فيها مسارات
 * لا ترسل بريدًا أصلًا — ولانكسر البناء في سياق المتصفّح.
 */
async function sendViaSmtp(msg: MailMessage): Promise<void> {
  const nodemailer = (await import("nodemailer")).default;
  // مهلات صريحة: مزوّد SMTP يقبل الاتصال ثم يتجمّد كان يعلّق ردّ التسجيل
  // أو الاستعادة دقائقَ (better-auth ينتظر هذه الدالة). بدونها لا سقف.
  const transport = nodemailer.createTransport(env().SMTP_URL, {
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  });
  await transport.sendMail({
    from: fromAddress(),
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
}

/**
 * Resend عبر REST مباشرة بلا SDK — الطلب سطر واحد، وإضافة اعتمادية
 * كاملة من أجله تكبير للحزمة بلا مقابل.
 */
async function sendViaResend(msg: MailMessage): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env().RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
    // مهلة صريحة: انقطاع Resend (يقبل الاتصال ثم يتجمّد) كان يعلّق كل تسجيل
    // واستعادة دقائق، لأن better-auth ينتظر إتمام هذه الدالة قبل الردّ.
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  });

  if (!res.ok) {
    // نص الرد يحمل سبب الرفض (نطاق غير موثّق، مفتاح منتهٍ…) — بدونه
    // يصبح تشخيص فشل الإرسال في الإنتاج تخمينًا
    const body = await res.text().catch(() => "");
    throw new Error(`Resend rejected the message (${res.status}): ${body}`);
  }
}

/** ينقل الرسالة عبر المزوّد المضبوط في البيئة. قد يرمي — والمناداة تتكفّل. */
export async function deliver(msg: MailMessage): Promise<void> {
  switch (env().MAIL_PROVIDER) {
    case "smtp":
      await sendViaSmtp(msg);
      return;
    case "resend":
      await sendViaResend(msg);
      return;
    default:
      sendViaConsole(msg);
  }
}
