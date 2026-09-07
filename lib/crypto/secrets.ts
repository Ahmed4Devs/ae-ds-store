import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { env } from "@/lib/env";

const PREFIX = "enc:v1";

function key(): Buffer | null {
  const encoded = env().AE_TOKEN_ENCRYPTION_KEY;
  return encoded ? Buffer.from(encoded, "base64url") : null;
}

export function secretEncryptionEnabled(): boolean {
  return key() !== null;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

/** AES-256-GCM مع nonce عشوائي وAAD يمنع نقل ciphertext بين غرضين. */
export function encryptSecret(value: string, purpose: string): string {
  if (!value) return value;
  const encryptionKey = key();
  if (!encryptionKey) return value; // مسموح في mock/development فقط

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(`ae-ds-store/${purpose}/v1`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(value: string, purpose: string): string {
  if (!value || !isEncryptedSecret(value)) return value;
  const encryptionKey = key();
  if (!encryptionKey) {
    throw new Error("مفتاح تشفير رموز AliExpress غير متاح.");
  }

  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("صيغة الرمز المشفّر غير صالحة.");
  }

  try {
    const iv = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const ciphertext = Buffer.from(parts[4], "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error("invalid encryption parameters");
    }
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAAD(Buffer.from(`ae-ds-store/${purpose}/v1`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // رسالة عامة: لا نكشف أي جزء من ciphertext أو المفتاح في السجلّ.
    throw new Error("تعذّر فك رمز AliExpress المخزّن؛ تحقق من مفتاح التشفير.");
  }
}
