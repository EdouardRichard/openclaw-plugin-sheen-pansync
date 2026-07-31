import {
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptRecord, encryptRecord } from "../../src/credentials/crypto.js";

describe("credential crypto", () => {
  it("round-trips a versioned record", () => {
    const key = randomBytes(32);
    const record = { formatVersion: 1, credentialVersion: 7, clientId: "client" };
    expect(decryptRecord(key, encryptRecord(key, record))).toEqual(record);
  });

  it("uses AES-256-GCM with a fresh Base64URL nonce and the v1 AAD", () => {
    const key = randomBytes(32);
    const record = { formatVersion: 1, credentialVersion: 7, clientId: "client" };
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
    decipher.setAAD(Buffer.from("openclaw-pan-sync-helper:credentials:v1", "utf8"));
    decipher.setAuthTag(Buffer.from(first.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(first.ciphertext, "base64url")),
      decipher.final(),
    ]);
    expect(JSON.parse(plaintext.toString("utf8"))).toEqual(record);
  });

  it("rejects modified ciphertext", () => {
    const key = randomBytes(32);
    const envelope = encryptRecord(key, { formatVersion: 1, credentialVersion: 1 });
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    expect(() => decryptRecord(key, envelope)).toThrow("credential ciphertext rejected");
  });

  it("rejects unsupported envelope metadata without exposing ciphertext", () => {
    const key = randomBytes(32);
    const envelope = encryptRecord(key, { formatVersion: 1, credentialVersion: 1 });
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
      encryptRecord(randomBytes(31), { formatVersion: 1, credentialVersion: 1 }),
    ).toThrow("credential key rejected");
  });
});
