import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for secrets at rest (app client secrets, access/refresh
// tokens). Values are stored as "enc:v1:<iv>:<tag>:<ciphertext>" (base64
// parts), so encrypted values can be told apart from legacy plain text and
// the format can change later without guessing.
//
// ENCRYPTION_KEY must be 32 random bytes, base64-encoded:
//   openssl rand -base64 32
// Every environment that reads the same database must use the same key.

const PREFIX = "enc:v1:";
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is not set.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).",
    );
  }
  cachedKey = key;
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encrypt(plainText: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const cipherText = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return (
    PREFIX +
    [iv, tag, cipherText].map((part) => part.toString("base64")).join(":")
  );
}

export function decrypt(value: string): string {
  if (!isEncrypted(value)) {
    throw new Error("Value is not in the expected encrypted format.");
  }

  const [iv, tag, cipherText] = value
    .slice(PREFIX.length)
    .split(":")
    .map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !cipherText) {
    throw new Error("Encrypted value is malformed.");
  }

  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString(
    "utf8",
  );
}
