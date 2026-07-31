import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { EncryptedEnvelopeV1 } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const AAD = Buffer.from("openclaw-pan-sync-helper:credentials:v1", "utf8");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function requireKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error("credential key rejected");
  }
}

function decodeBase64Url(value: unknown): Buffer | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

export function encryptRecord<T>(
  key: Buffer,
  record: T,
): EncryptedEnvelopeV1 {
  requireKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(record), "utf8"),
    cipher.final(),
  ]);

  return {
    formatVersion: 1,
    algorithm: ALGORITHM,
    nonce: nonce.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptRecord<T>(
  key: Buffer,
  envelope: EncryptedEnvelopeV1,
): T {
  requireKey(key);

  try {
    if (
      envelope === null
      || typeof envelope !== "object"
      || envelope.formatVersion !== 1
      || envelope.algorithm !== ALGORITHM
    ) {
      throw new Error();
    }

    const nonce = decodeBase64Url(envelope.nonce);
    const authTag = decodeBase64Url(envelope.authTag);
    const ciphertext = decodeBase64Url(envelope.ciphertext);
    if (
      nonce?.length !== NONCE_BYTES
      || authTag?.length !== AUTH_TAG_BYTES
      || ciphertext === undefined
    ) {
      throw new Error();
    }

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new Error("credential ciphertext rejected");
  }
}
