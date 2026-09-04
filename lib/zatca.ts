import QRCode from "qrcode";

/**
 * رمز الاستجابة السريعة للفاتورة الضريبية المبسّطة — المرحلة الأولى من
 * الفوترة الإلكترونية لدى هيئة الزكاة والضريبة والجمارك.
 *
 * الهيئة تشترط تسلسل TLV من خمسة حقول بترتيب وأرقام وسوم محدّدة، مُرمَّزًا
 * base64. الفخّ الذي يجعل الرمز غير قابل للمسح: كتابة الطول بعدد المحارف
 * بدل عدد البايتات. اسم المنشأة عربي، والحرف العربي بايتان في UTF-8، فلو
 * استُخدم `.length` لخرج الطول أقصر من القيمة الفعلية وانزاح كل ما بعده
 * في السلسلة فصار المحتوى بلا معنى للقارئ.
 *
 * هذا الملف خادمي بحت (Buffer + qrcode) — لا يُستورد داخل مكوّن عميل.
 */

export interface ZatcaInvoice {
  sellerName: string;
  vatNumber: string;
  issuedAt: Date;
  totalWithVat: number;
  vatTotal: number;
}

/** أرقام الوسوم مثبَّتة في المواصفة ولا تُشتق من الترتيب. */
const TAG_SELLER_NAME = 1;
const TAG_VAT_NUMBER = 2;
const TAG_TIMESTAMP = 3;
const TAG_TOTAL_WITH_VAT = 4;
const TAG_VAT_TOTAL = 5;

/** خانة الطول بايت واحد، فأقصى قيمة 255 بايت لكل حقل. */
const MAX_FIELD_BYTES = 255;

/**
 * يقصّ القيمة عند حدّ البايتات دون شطر محرف متعدّد البايتات نصفين.
 * القصّ الأعمى على البايت كان يُخرج بايت بداية بلا تكملته فيتلف الترميز.
 */
function clampToBytes(value: string, max: number): Buffer {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= max) return buf;

  const cut = buf.subarray(0, max);
  // TextDecoder مع fatal=false يستبدل البقايا المبتورة بمحرف بديل،
  // فنعيد الترميز بعد إسقاطه للحصول على نصّ سليم أقصر من الحد.
  const text = new TextDecoder("utf-8").decode(cut).replace(/�+$/u, "");
  return Buffer.from(text, "utf8");
}

/** حقل واحد: [وسم][طول بالبايت][القيمة]. */
function tlvField(tag: number, value: string): Buffer {
  const bytes = clampToBytes(value, MAX_FIELD_BYTES);
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

/** المبالغ تُكتب بمنزلتين عشريتين نصًّا صريحًا، لا بتنسيق محلّي فيه فواصل. */
function money(amount: number): string {
  return (Number.isFinite(amount) ? amount : 0).toFixed(2);
}

/**
 * الطابع الزمني بصيغة ISO 8601 بتوقيت UTC وبلا أجزاء الثانية —
 * `toISOString` يضيف ثلاث خانات ميلي ثانية لا تقبلها بعض قارئات الهيئة.
 */
function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** يبني تسلسل TLV كاملًا ويعيده مُرمَّزًا base64. */
export function buildZatcaTlv(inv: ZatcaInvoice): string {
  const tlv = Buffer.concat([
    tlvField(TAG_SELLER_NAME, inv.sellerName),
    tlvField(TAG_VAT_NUMBER, inv.vatNumber),
    tlvField(TAG_TIMESTAMP, isoTimestamp(inv.issuedAt)),
    tlvField(TAG_TOTAL_WITH_VAT, money(inv.totalWithVat)),
    tlvField(TAG_VAT_TOTAL, money(inv.vatTotal)),
  ]);

  return tlv.toString("base64");
}

/**
 * يحوّل السلسلة المرمَّزة إلى صورة PNG بصيغة data URL.
 *
 * مستوى تصحيح الأخطاء M هو التوازن المعتاد للفواتير المطبوعة: يحتمل بهتان
 * الحبر ولا يضخّم كثافة الرمز كما يفعل H. والهامش أربع وحدات لأن الرمز
 * الملاصق لحدّ الورقة يفشل مسحه.
 */
export async function zatcaQrDataUrl(base64Tlv: string): Promise<string> {
  return QRCode.toDataURL(base64Tlv, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 240,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
}
