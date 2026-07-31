import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRecord } from "../../src/credentials/types.js";
import {
  type CredentialFileAdapter,
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

async function rejectedError(run: () => Promise<unknown>): Promise<Error> {
  let rejected: unknown;
  try {
    await run();
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(Error);
  return rejected as Error;
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
          throw new Error(`injected rename failure ${dataDir}`);
        }
        await rename(source, destination);
      },
    });
    await store.replace(initial);
    const previousCiphertext = await readFile(credentialsPath);
    failNextRename = true;

    const error = await rejectedError(() => store.replace(record(2)));

    expect(error.message).toBe("credential store write failed");
    expect(error.message).not.toContain("injected rename failure");
    expect(error.message).not.toContain(dataDir);
    expect(await readFile(credentialsPath)).toEqual(previousCiphertext);
    await expect(store.read()).resolves.toEqual(initial);
  });

  it("sanitizes read failures without exposing filesystem paths", async () => {
    const dataDir = await tempDataDir();
    const masterKeyPath = path.join(dataDir, "master.key");
    const store = new CredentialStore(dataDir, immediateLease);
    await store.replace(record(1));
    await unlink(masterKeyPath);

    const error = await rejectedError(() => store.read());

    expect(error.message).toBe("credential store read failed");
    expect(error.message).not.toContain(dataDir);
    expect(error.message).not.toContain("ENOENT");
  });

  it("sanitizes clear failures without exposing filesystem paths", async () => {
    const dataDir = path.join(await tempDataDir(), "clear-path-CANARY");
    const credentialsPath = path.join(dataDir, "credentials.enc");
    await mkdir(credentialsPath, { recursive: true });
    const store = new CredentialStore(dataDir, immediateLease);

    const error = await rejectedError(() => store.clear());

    expect(error.message).toBe("credential store clear failed");
    expect(error.message).not.toContain("clear-path-CANARY");
    expect(error.message).not.toContain(credentialsPath);
  });

  it("restores previous ciphertext when post-rename directory sync fails", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    const previousCiphertext = await readFile(credentialsPath);
    let replacementRenamed = false;
    let failPostRenameSync = true;
    const syncFailureAdapter: Partial<CredentialFileAdapter> = {
      async rename(source: string, destination: string) {
        await rename(source, destination);
        if (destination === credentialsPath) {
          replacementRenamed = true;
        }
      },
      async syncDirectory() {
        if (replacementRenamed && failPostRenameSync) {
          failPostRenameSync = false;
          throw new Error(`POST_RENAME_SYNC_CANARY ${dataDir}`);
        }
      },
    };
    const store = new CredentialStore(dataDir, immediateLease, syncFailureAdapter);

    const error = await rejectedError(() => store.replace(record(2)));

    expect(error.message).toBe("credential store write failed");
    expect(error.message).not.toContain("POST_RENAME_SYNC_CANARY");
    expect(error.message).not.toContain(dataDir);
    expect(await readFile(credentialsPath)).toEqual(previousCiphertext);
    await expect(seedStore.read()).resolves.toEqual(initial);
  });

  it("commits the installed replacement when rollback rename fails", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const replacement = record(2);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    let canonicalRenames = 0;
    let replacementInstalled = false;
    let failPostRenameSync = true;
    const rollbackRenameFailureAdapter: Partial<CredentialFileAdapter> = {
      async rename(source, destination) {
        if (destination === credentialsPath) {
          canonicalRenames += 1;
          if (canonicalRenames === 2) {
            throw new Error(`ROLLBACK_RENAME_CANARY ${dataDir}`);
          }
        }
        await rename(source, destination);
        if (destination === credentialsPath) {
          replacementInstalled = true;
        }
      },
      async syncDirectory() {
        if (replacementInstalled && failPostRenameSync) {
          failPostRenameSync = false;
          throw new Error(`POST_RENAME_SYNC_CANARY ${dataDir}`);
        }
      },
    };
    const store = new CredentialStore(
      dataDir,
      immediateLease,
      rollbackRenameFailureAdapter,
    );

    await expect(store.replace(replacement)).resolves.toBeUndefined();

    expect(canonicalRenames).toBe(2);
    await expect(seedStore.read()).resolves.toEqual(replacement);
  });

  it("retries rollback directory sync before rejecting with the previous record", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    let replacementInstalled = false;
    let syncCalls = 0;
    const rollbackSyncFailureAdapter: Partial<CredentialFileAdapter> = {
      async rename(source, destination) {
        await rename(source, destination);
        if (destination === credentialsPath) {
          replacementInstalled = true;
        }
      },
      async syncDirectory() {
        syncCalls += 1;
        if (replacementInstalled && (syncCalls === 2 || syncCalls === 3)) {
          throw new Error(`ROLLBACK_SYNC_CANARY ${dataDir}`);
        }
      },
    };
    const store = new CredentialStore(
      dataDir,
      immediateLease,
      rollbackSyncFailureAdapter,
    );

    const error = await rejectedError(() => store.replace(record(2)));

    expect(error.message).toBe("credential store write failed");
    expect(error.message).not.toContain("ROLLBACK_SYNC_CANARY");
    expect(error.message).not.toContain(dataDir);
    expect(syncCalls).toBe(4);
    await expect(seedStore.read()).resolves.toEqual(initial);
  });

  it("performs no filesystem mutations when CAS is stale", async () => {
    const dataDir = await tempDataDir();
    const masterKeyPath = path.join(dataDir, "master.key");
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(record(1));
    await chmod(masterKeyPath, 0o400);
    const modeBefore = await octalMode(masterKeyPath);
    const ciphertextBefore = await readFile(credentialsPath);
    const mutations: string[] = [];
    const observingAdapter: Partial<CredentialFileAdapter> = {
      async chmod(target: string, mode: number) {
        mutations.push(`chmod:${target}:${mode}`);
        await chmod(target, mode);
      },
      async link(existingPath: string, newPath: string) {
        mutations.push(`link:${existingPath}:${newPath}`);
        await link(existingPath, newPath);
      },
      async mkdir(directory: string, options: { recursive: true; mode: number }) {
        mutations.push(`mkdir:${directory}`);
        await mkdir(directory, options);
      },
      async open(target: string, flags: string, mode?: number) {
        mutations.push(`open:${target}:${flags}`);
        return open(target, flags, mode);
      },
      async rename(source: string, destination: string) {
        mutations.push(`rename:${source}:${destination}`);
        await rename(source, destination);
      },
      async unlink(target: string) {
        mutations.push(`unlink:${target}`);
        await unlink(target);
      },
      async syncDirectory(directory: string) {
        mutations.push(`sync:${directory}`);
      },
    };
    const store = new CredentialStore(dataDir, immediateLease, observingAdapter);

    await expect(store.replaceIfVersion(99, record(2))).resolves.toBe(false);

    expect(mutations).toEqual([]);
    expect(await octalMode(masterKeyPath)).toBe(modeBefore);
    expect(await readFile(credentialsPath)).toEqual(ciphertextBefore);
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

    await expect(store.read()).rejects.toThrow("credential store read failed");
    await expect(store.replace(record(1))).rejects.toThrow(
      "credential store write failed",
    );
    await expect(store.replaceIfVersion(1, record(2))).rejects.toThrow(
      "credential store write failed",
    );
    await expect(store.clear()).rejects.toThrow("credential store clear failed");
  });
});
