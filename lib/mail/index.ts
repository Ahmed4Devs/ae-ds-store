import { deliver, type MailMessage } from "@/lib/mail/providers";

/**
 * واجهة البريد الوحيدة لبقية المتجر.
 *
 * لا يستورد أحد `providers` ولا `templates` مباشرة: الواجهة هنا هي العقد،
 * فيبقى تبديل المزوّد أو إعادة كتابة القالب تغييرًا داخليًا لا يلمس مناديه.
 */

/**
 * يرسل رسالة جاهزة. **يرمي عند الفشل** عمدًا — الملفّات التي ترسل ضمن
 * مسار طلبية (رسائل الطلبيات) تبتلع أخطاءها بنفسها، أما المنادي الذي
 * يحتاج معرفة نتيجة الإرسال فيجب ألا يُخفى عنه الفشل.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  await deliver(msg);
}

export {
  escapeHtml,
  localeFromRequest,
  renderMail,
  sendEmailVerificationMail,
  sendOrderCancelledMail,
  sendOrderPlacedMail,
  sendOrderShippedMail,
  sendPasswordResetMail,
} from "@/lib/mail/templates";

export type { MailMessage };
export type { RenderMailOptions } from "@/lib/mail/templates";
