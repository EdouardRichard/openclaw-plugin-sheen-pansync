import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRecord } from "../../src/credentials/types.js";
import {
  CredentialStore,
  type CredentialLeaseRunner,
} from "../../src/credentials/store.js";
import { createTempState, octalMode } from "../helpers/temp-state.js";

const immediateLease: CredentialLeaseRunner = (_key, run) => run();

function record(
  credentialVersion: number,
  refreshToken = `refresh-${credentialVersion}`,
): CredentialRecord {
  return {
    formatVersion: 1,
    credentialVersion,
    clientId: "client-id-CANARY",
    clientSecret: "client-secret-CANARY",
    refreshToken,
    accessToken: `access-${credentialVersion}-CANARY`,
    accessTokenExpiresAt: "2026-08-01T00:00:00.000Z",
    account: {
      userIdMasked: "user-***-masked",
      displayNameMasked: "name-***",
    },
    lastVerifiedAt: "2026-07-31T00:00:00.000Z",
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function tempDataDir(): Promise<string> {
  const state = await createTempState();
  cleanups.push(state.cleanup);
  return state.dataDir;
}

describe("CredentialStore", () => {
  it("returns undefined when credentials have not been configured", async () => {
    const store = new CredentialStore(await tempDataDir(), immediateLease);
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("stores only encrypted credentials and enforces Linux permission modes", async () => {
    const dataDir = await tempDataDir();
    const masterKeyPath = path.join(dataDir, "master.key");
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const store = new CredentialStore(dataDir, immediateLease);
    const saved = record(1);

    await store.replace(saved);

    expect(await readFile(masterKeyPath)).toHaveLength(32);
    const encrypted = await readFile(credentialsPath, "utf8");
    expect(encrypted).not.toContain(saved.clientSecret);
    expect(encrypted).not.toContain(saved.refreshToken);
    expect(encrypted).not.toContain(saved.accessToken);
    await expect(store.read()).resolves.toEqual(saved);

    if (process.platform !== "win32") {
      expect(await octalMode(dataDir)).toBe("700");
      expect(await octalMode(masterKeyPath)).toBe("600");
      expect(await octalMode(credentialsPath)).toBe("600");
    }
  });

  it("replaces only the expected credential version", async () => {
    const store = new CredentialStore(await tempDataDir(), immediateLease);
    const initial = record(1);
    const newer = record(2);
    const stale = record(3, "stale-refresh");
    await store.replace(initial);

    await expect(store.replaceIfVersion(1, newer)).resolves.toBe(true);
    await expect(store.replaceIfVersion(1, stale)).resolves.toBe(false);
    expect(await store.read()).toEqual(newer);
  });

  it("preserves the previous ciphertext when atomic rename fails", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    let failNextRename = false;
    const store = new CredentialStore(dataDir, immediateLease, {
      async rename(source, destination) {
        if (failNextRename) {
          failNextRename = false;
          throw new Error("injected rename failure");
        }
        await rename(source, destination);
      },
    });
    await store.replace(initial);
    const previousCiphertext = await readFile(credentialsPath);
    failNextRename = true;

    await expect(store.replace(record(2))).rejects.toThrow("injected rename failure");

    expect(await readFile(credentialsPath)).toEqual(previousCiphertext);
    await expect(store.read()).resolves.toEqual(initial);
  });

  it("clears configured credentials without deleting the master key", async () => {
    const dataDir = await tempDataDir();
    const masterKeyPath = path.join(dataDir, "master.key");
    const store = new CredentialStore(dataDir, immediateLease);
    await store.replace(record(1));
    const key = await readFile(masterKeyPath);

    await store.clear();

    await expect(store.read()).resolves.toBeUndefined();
    await expect(readFile(masterKeyPath)).resolves.toEqual(key);
  });

  it("runs every operation through the injected credential lease", async () => {
    const dataDir = await tempDataDir();
    const deniedLease: CredentialLeaseRunner = async () => {
      throw new Error("credential lease denied");
    };
    const store = new CredentialStore(dataDir, deniedLease);

    await expect(store.read()).rejects.toThrow("credential lease denied");
    await expect(store.replace(record(1))).rejects.toThrow("credential lease denied");
    await expect(store.replaceIfVersion(1, record(2))).rejects.toThrow(
      "credential lease denied",
    );
    await expect(store.clear()).rejects.toThrow("credential lease denied");
  });
});
