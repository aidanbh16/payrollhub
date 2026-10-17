import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fieldEncryptionKey } from "@/data/keys/kms";

// Encryption at rest for bank routing and account numbers, TOTP secrets, and ACH file bodies.
// Format: [version 1 byte][iv 12 bytes][auth tag 16 bytes][ciphertext].
// The context (tenant, column, row id) is bound as additional authenticated data, so a ciphertext copied
// into another row, column, or tenant fails to decrypt instead of being read as valid.
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// The key comes from the key store, the single source of key material (data/keys/kms.ts).
const key = fieldEncryptionKey;

export function fieldContext(tenantId: string, column: string, rowId: string): string {
  return `${tenantId}|${column}|${rowId}`;
}

export function encryptField(plaintext: string, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptField(blob: Buffer, context: string): string {
  if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) {
    throw new Error("Encrypted field has an unknown format");
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}
