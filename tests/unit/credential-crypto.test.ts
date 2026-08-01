import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptRecord, encryptRecord } from "../../src/credentials/crypto.js";

describe("credential crypto", () => {
  const record = {
    formatVersion: 2 as const,
    credentialVersion: 7,
    authorizationPageUrl: "http://auth.example.test/custom",
    refreshApiUrl: "http://refresh.example.test/custom/renew",
    refreshToken: "refresh-token-CANARY",
    accessToken: "access-token-CANARY",
    account: { userIdMasked: "use***42", displayNameMasked: "A***" },
    lastVerifiedAt: "2026-08-01T00:00:00.000Z",
    refreshState: { status: "ready" as const },
  };

  it("round-trips a versioned record", () => {
    const key = randomBytes(32);
    expect(decryptRecord(key, encryptRecord(key, record))).toEqual(record);
  });

  it("uses AES-256-GCM with a fresh Base64URL nonce and the v2 AAD", () => {
    const key = randomBytes(32);
    const first = encryptRecord(key, record);
    const second = encryptRecord(key, record);

    expect(first).toMatchObject({
      formatVersion: 1,
      algorithm: "aes-256-gcm",
    });
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(first.authTag).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.nonce).not.toBe(second.nonce);

    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(first.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from("openclaw-pan-sync-helper:credentials:v2", "utf8"));
    decipher.setAuthTag(Buffer.from(first.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(first.ciphertext, "base64url")),
      decipher.final(),
    ]);
    expect(JSON.parse(plaintext.toString("utf8"))).toEqual(record);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(record.authorizationPageUrl);
    expect(serialized).not.toContain(record.refreshApiUrl);
    expect(serialized).not.toContain(record.refreshToken);
    expect(serialized).not.toContain(record.accessToken);
  });

  it("rejects a version-1 AAD envelope without a compatibility fallback", () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("openclaw-pan-sync-helper:credentials:v1", "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(record), "utf8"),
      cipher.final(),
    ]);
    const envelope = {
      formatVersion: 1 as const,
      algorithm: "aes-256-gcm" as const,
      nonce: nonce.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };

    expect(() => decryptRecord(key, envelope)).toThrow(
      "credential ciphertext rejected",
    );
  });

  it("rejects modified ciphertext", () => {
    const key = randomBytes(32);
    const envelope = encryptRecord(key, record);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    expect(() => decryptRecord(key, envelope)).toThrow("credential ciphertext rejected");
  });

  it("rejects unsupported envelope metadata without exposing ciphertext", () => {
    const key = randomBytes(32);
    const envelope = encryptRecord(key, record);
    const ciphertextCanary = envelope.ciphertext;

    let thrown: unknown;
    try {
      decryptRecord(key, { ...envelope, algorithm: "aes-128-gcm" } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("credential ciphertext rejected");
    expect((thrown as Error).message).not.toContain(ciphertextCanary);
  });

  it("requires an exact 32-byte master key", () => {
    expect(() =>
      encryptRecord(randomBytes(31), record),
    ).toThrow("credential key rejected");
  });
});
