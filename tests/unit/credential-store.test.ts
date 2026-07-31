import {
  chmod,
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRecord } from "../../src/credentials/types.js";
import {
  type CredentialFileAdapter,
  type CredentialLeaseContext,
  CredentialStore,
  type CredentialLeaseRunner,
} from "../../src/credentials/store.js";
import { createTempState, octalMode } from "../helpers/temp-state.js";

const ownedLease: CredentialLeaseContext = {
  assertOwned: async () => undefined,
};
const immediateLease: CredentialLeaseRunner = (_key, run) => run(ownedLease);

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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

function v2TransactionPaths(dataDir: string, transactionId: string) {
  return {
    markerPath: path.join(dataDir, `.credentials.${transactionId}.txn`),
    backupPath: path.join(
      dataDir,
      `.credentials.enc.${transactionId}.bak`,
    ),
  };
}

async function writeV2Marker(
  dataDir: string,
  transactionId: string,
  hadCanonical: boolean,
): Promise<{ markerPath: string; backupPath: string }> {
  const paths = v2TransactionPaths(dataDir, transactionId);
  await writeFile(
    paths.markerPath,
    `${JSON.stringify({
      formatVersion: 2,
      transactionId,
      hadCanonical,
      backupName: path.basename(paths.backupPath),
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return paths;
}

async function snapshotDataDirectory(
  dataDir: string,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const name of (await readdir(dataDir)).sort()) {
    snapshot[name] = (await readFile(path.join(dataDir, name))).toString("base64");
  }
  return snapshot;
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

  it("creates only when the expected credential state is absent", async () => {
    const store = new CredentialStore(await tempDataDir(), immediateLease);
    const first = record(1);
    const staleFirst = record(1, "stale-first-refresh");

    await expect(store.replaceIfVersion(undefined, first)).resolves.toBe(true);
    await expect(store.replaceIfVersion(undefined, staleFirst)).resolves.toBe(false);
    await expect(store.read()).resolves.toEqual(first);
  });

  it("does not mutate when a Vault operation is already cancelled", async () => {
    const store = new CredentialStore(await tempDataDir(), immediateLease);
    const initial = record(1);
    await store.replace(initial);
    const controller = new AbortController();
    controller.abort();

    await expect(store.replaceIfVersion(1, record(2), { signal: controller.signal })).resolves.toBe(false);
    await expect(store.clear({ signal: controller.signal })).resolves.toBeUndefined();
    await expect(store.read()).resolves.toEqual(initial);
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

  it("verifies lease ownership after journaling and before replacing canonical credentials", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    await new CredentialStore(dataDir, immediateLease).replace(initial);
    const previousCiphertext = await readFile(credentialsPath);
    let owned = true;
    let canonicalRenamed = false;
    const lease: CredentialLeaseRunner = (_key, run) => run({
      async assertOwned() {
        if (!owned) throw new Error("lease-owner-CANARY");
      },
    });
    const store = new CredentialStore(dataDir, lease, {
      async link(existingPath, newPath) {
        await link(existingPath, newPath);
        if (/\.credentials\.enc\.[a-f0-9]{32}\.bak$/.test(newPath)) {
          owned = false;
        }
      },
      async rename(source, destination) {
        if (destination === credentialsPath) canonicalRenamed = true;
        await rename(source, destination);
      },
    });

    await expect(store.replace(record(2))).rejects.toThrow(
      "credential store write failed",
    );

    expect(canonicalRenamed).toBe(false);
    await expect(readFile(credentialsPath)).resolves.toEqual(previousCiphertext);
    await expect(
      new CredentialStore(dataDir, immediateLease).read(),
    ).resolves.toEqual(initial);
  });

  it("never rolls a losing writer over a newer canonical credential", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const seed = new CredentialStore(dataDir, immediateLease);
    const initial = record(1);
    const winner = record(3, "winner-refresh-CANARY");
    await seed.replace(initial);
    await seed.replace(winner);
    const winnerCiphertext = await readFile(credentialsPath);
    await seed.replace(initial);
    let losingCanonicalInstalled = false;
    let winnerInstalled = false;
    const lease: CredentialLeaseRunner = (_key, run) => run({
      async assertOwned() {
        if (!losingCanonicalInstalled || winnerInstalled) return;
        winnerInstalled = true;
        const winnerPath = path.join(dataDir, ".winner.credentials.tmp");
        await writeFile(winnerPath, winnerCiphertext, {
          flag: "wx",
          mode: 0o600,
        });
        await rename(winnerPath, credentialsPath);
        for (const name of await readdir(dataDir)) {
          if (name.endsWith(".txn") || name.endsWith(".bak")) {
            await unlink(path.join(dataDir, name)).catch(() => undefined);
          }
        }
        throw new Error("credential lease ownership lost");
      },
    });
    const loser = new CredentialStore(dataDir, lease, {
      async rename(source, destination) {
        await rename(source, destination);
        if (
          destination === credentialsPath
          && path.basename(source).endsWith(".tmp")
        ) {
          losingCanonicalInstalled = true;
        }
      },
    });

    await expect(loser.replace(record(2))).rejects.toThrow(
      "credential store write failed",
    );

    expect(winnerInstalled).toBe(true);
    await expect(readFile(credentialsPath)).resolves.toEqual(winnerCiphertext);
    await expect(seed.read()).resolves.toEqual(winner);
  });

  it("performs no rollback mutation when ownership is lost after its last identity observation", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const seed = new CredentialStore(dataDir, immediateLease);
    const initial = record(1);
    const winner = record(3, "winner-after-observation-CANARY");
    await seed.replace(initial);
    await seed.replace(winner);
    const winnerCiphertext = await readFile(credentialsPath);
    await seed.replace(initial);
    let owned = true;
    let losingCanonicalInstalled = false;
    let failPostRenameSync = true;
    let winnerInstalled = false;
    const lease: CredentialLeaseRunner = (_key, run) => run({
      async assertOwned() {
        if (!owned) throw new Error("credential lease ownership lost");
      },
    });
    const store = new CredentialStore(dataDir, lease, {
      async open(target, flags, mode) {
        const handle = await open(target, flags, mode);
        if (
          target !== credentialsPath
          || flags !== "r"
          || !losingCanonicalInstalled
          || winnerInstalled
        ) {
          return handle;
        }
        return {
          async stat() {
            const observed = await handle.stat();
            await handle.close();
            winnerInstalled = true;
            const winnerPath = path.join(dataDir, ".winner-after-observation.tmp");
            await writeFile(winnerPath, winnerCiphertext, {
              flag: "wx",
              mode: 0o600,
            });
            await rename(winnerPath, credentialsPath);
            for (const name of await readdir(dataDir)) {
              if (name.endsWith(".txn") || name.endsWith(".bak")) {
                await unlink(path.join(dataDir, name)).catch(() => undefined);
              }
            }
            owned = false;
            return observed;
          },
          async close() {},
        } as FileHandle;
      },
      async rename(source, destination) {
        await rename(source, destination);
        if (
          destination === credentialsPath
          && path.basename(source).endsWith(".tmp")
        ) {
          losingCanonicalInstalled = true;
        }
      },
      async syncDirectory() {
        if (losingCanonicalInstalled && failPostRenameSync) {
          failPostRenameSync = false;
          throw new Error("post-rename-sync-CANARY");
        }
      },
    });

    await expect(store.replace(record(2))).rejects.toThrow(
      "credential store write failed",
    );

    expect(winnerInstalled).toBe(true);
    await expect(readFile(credentialsPath)).resolves.toEqual(winnerCiphertext);
    await expect(seed.read()).resolves.toEqual(winner);
  });

  it("does not restore or clean up after clear observes ownership loss", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const seed = new CredentialStore(dataDir, immediateLease);
    const winner = record(3, "winner-during-clear-CANARY");
    await seed.replace(record(1));
    await seed.replace(winner);
    const winnerCiphertext = await readFile(credentialsPath);
    await seed.replace(record(1));
    let canonicalDeleted = false;
    let ownershipLost = false;
    const postLossMutations: string[] = [];
    const lease: CredentialLeaseRunner = (_key, run) => run({
      async assertOwned() {
        if (!canonicalDeleted || ownershipLost) {
          if (ownershipLost) throw new Error("credential lease ownership lost");
          return;
        }
        const winnerPath = path.join(dataDir, ".winner-during-clear.tmp");
        await writeFile(winnerPath, winnerCiphertext, {
          flag: "wx",
          mode: 0o600,
        });
        await rename(winnerPath, credentialsPath);
        for (const name of await readdir(dataDir)) {
          if (name.endsWith(".txn") || name.endsWith(".bak")) {
            await unlink(path.join(dataDir, name)).catch(() => undefined);
          }
        }
        ownershipLost = true;
        throw new Error("credential lease ownership lost");
      },
    });
    const store = new CredentialStore(dataDir, lease, {
      async link(existingPath, newPath) {
        if (ownershipLost) postLossMutations.push(`link:${newPath}`);
        await link(existingPath, newPath);
      },
      async unlink(target) {
        if (ownershipLost) postLossMutations.push(`unlink:${target}`);
        await unlink(target);
        if (target === credentialsPath) canonicalDeleted = true;
      },
      async syncDirectory(directory) {
        if (ownershipLost) postLossMutations.push(`sync:${directory}`);
      },
    });

    await expect(store.clear()).rejects.toThrow("credential store clear failed");

    expect(postLossMutations).toEqual([]);
    await expect(readFile(credentialsPath)).resolves.toEqual(winnerCiphertext);
    await expect(seed.read()).resolves.toEqual(winner);
  });

  it("verifies lease ownership after clear backup and before canonical deletion", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    await new CredentialStore(dataDir, immediateLease).replace(initial);
    const previousCiphertext = await readFile(credentialsPath);
    let owned = true;
    let canonicalUnlinked = false;
    const lease: CredentialLeaseRunner = (_key, run) => run({
      async assertOwned() {
        if (!owned) throw new Error("lease-owner-CANARY");
      },
    });
    const store = new CredentialStore(dataDir, lease, {
      async link(existingPath, newPath) {
        await link(existingPath, newPath);
        if (newPath.endsWith(".bak")) owned = false;
      },
      async unlink(target) {
        if (target === credentialsPath) canonicalUnlinked = true;
        await unlink(target);
      },
    });

    await expect(store.clear()).rejects.toThrow("credential store clear failed");

    expect(canonicalUnlinked).toBe(false);
    await expect(readFile(credentialsPath)).resolves.toEqual(previousCiphertext);
    await expect(
      new CredentialStore(dataDir, immediateLease).read(),
    ).resolves.toEqual(initial);
  });

  it("passes mutation cancellation to filesystem lease acquisition", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const lease: CredentialLeaseRunner = (_key, run, options) => {
      observedSignal = options?.signal;
      return run(ownedLease);
    };
    const store = new CredentialStore(await tempDataDir(), lease);

    await expect(
      store.replaceIfVersion(undefined, record(1), {
        signal: controller.signal,
      }),
    ).resolves.toBe(true);

    expect(observedSignal).toBe(controller.signal);
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

  it("recovers the previous record after restart when rollback rename fails", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const replacement = record(2);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    const previousCiphertext = await readFile(credentialsPath);
    let canonicalRenames = 0;
    let replacementInstalled = false;
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
        if (replacementInstalled) {
          throw new Error(`POST_RENAME_SYNC_CANARY ${dataDir}`);
        }
      },
    };
    const store = new CredentialStore(
      dataDir,
      immediateLease,
      rollbackRenameFailureAdapter,
    );

    const error = await rejectedError(() => store.replace(replacement));
    const freshStore = new CredentialStore(dataDir, immediateLease);

    expect(error.message).toBe("credential store write failed");
    expect(canonicalRenames).toBe(2);
    expect(await readFile(credentialsPath)).not.toEqual(previousCiphertext);
    await expect(freshStore.read()).resolves.toEqual(initial);
  });

  it("recovers from a durable marker after repeated directory sync failure", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    const previousCiphertext = await readFile(credentialsPath);
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
    expect(syncCalls).toBeGreaterThanOrEqual(3);
    const transactionNames = (await readdir(dataDir)).filter((name) =>
      /^\.credentials\.[a-f0-9]{32}\.txn$/.test(name)
    );
    expect(transactionNames).toHaveLength(1);
    const transactionId = transactionNames[0]!.slice(
      ".credentials.".length,
      -".txn".length,
    );
    const marker = JSON.parse(
      await readFile(path.join(dataDir, transactionNames[0]!), "utf8"),
    ) as Record<string, unknown>;
    expect(marker).toEqual({
      formatVersion: 2,
      transactionId,
      hadCanonical: true,
      backupName: `.credentials.enc.${transactionId}.bak`,
    });
    await expect(
      readFile(path.join(dataDir, marker.backupName as string)),
    ).resolves.toEqual(previousCiphertext);
    const freshStore = new CredentialStore(dataDir, immediateLease);
    await expect(freshStore.read()).resolves.toEqual(initial);
  });

  it.each([
    ["restart read", "credential store read failed"],
    ["write recovery", "credential store write failed"],
    ["clear recovery", "credential store clear failed"],
  ] as const)(
    "fails closed before %s when v2 claims a canonical backup that is missing",
    async (operation, expectedError) => {
      const dataDir = await tempDataDir();
      const seed = new CredentialStore(dataDir, immediateLease);
      await seed.replace(record(1));
      const transactionId = "1".repeat(32);
      await writeV2Marker(dataDir, transactionId, true);
      const before = await snapshotDataDirectory(dataDir);
      const fresh = new CredentialStore(dataDir, immediateLease);
      const action = operation === "restart read"
        ? () => fresh.read()
        : operation === "write recovery"
        ? () => fresh.replace(record(2))
        : () => fresh.clear();

      await expect(action()).rejects.toThrow(expectedError);

      await expect(snapshotDataDirectory(dataDir)).resolves.toEqual(before);
    },
  );

  it.each([
    ["restart read", "credential store read failed"],
    ["write recovery", "credential store write failed"],
    ["clear recovery", "credential store clear failed"],
  ] as const)(
    "fails closed before %s when v2 denies a canonical but its claimed backup exists",
    async (operation, expectedError) => {
      const dataDir = await tempDataDir();
      const credentialsPath = path.join(dataDir, "credentials.enc");
      const seed = new CredentialStore(dataDir, immediateLease);
      await seed.replace(record(1));
      const transactionId = "2".repeat(32);
      const transaction = await writeV2Marker(dataDir, transactionId, false);
      await writeFile(transaction.backupPath, await readFile(credentialsPath), {
        flag: "wx",
        mode: 0o600,
      });
      const before = await snapshotDataDirectory(dataDir);
      const fresh = new CredentialStore(dataDir, immediateLease);
      const action = operation === "restart read"
        ? () => fresh.read()
        : operation === "write recovery"
        ? () => fresh.replace(record(2))
        : () => fresh.clear();

      await expect(action()).rejects.toThrow(expectedError);

      await expect(snapshotDataDirectory(dataDir)).resolves.toEqual(before);
    },
  );

  it.each([
    {
      name: "a mismatched backup",
      hadCanonical: true,
      backupIds: ["4".repeat(32)],
    },
    {
      name: "an exact plus an additional backup",
      hadCanonical: true,
      backupIds: ["3".repeat(32), "4".repeat(32)],
    },
    {
      name: "an unexpected mismatched backup for an absent canonical",
      hadCanonical: false,
      backupIds: ["4".repeat(32)],
    },
  ])("preserves all artifacts when v2 has $name", async ({
    hadCanonical,
    backupIds,
  }) => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const seed = new CredentialStore(dataDir, immediateLease);
    await seed.replace(record(1));
    const transactionId = "3".repeat(32);
    await writeV2Marker(dataDir, transactionId, hadCanonical);
    const ciphertext = await readFile(credentialsPath);
    for (const backupId of backupIds) {
      await writeFile(
        v2TransactionPaths(dataDir, backupId).backupPath,
        ciphertext,
        { flag: "wx", mode: 0o600 },
      );
    }
    const before = await snapshotDataDirectory(dataDir);

    await expect(
      new CredentialStore(dataDir, immediateLease).read(),
    ).rejects.toThrow("credential store read failed");

    await expect(snapshotDataDirectory(dataDir)).resolves.toEqual(before);
  });

  it("lets the current lease owner recover a valid v2 canonical backup before writing", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const seed = new CredentialStore(dataDir, immediateLease);
    await seed.replace(record(1));
    const previousCiphertext = await readFile(credentialsPath);
    await seed.replace(record(2));
    const transactionId = "5".repeat(32);
    const transaction = await writeV2Marker(dataDir, transactionId, true);
    await writeFile(transaction.backupPath, previousCiphertext, {
      flag: "wx",
      mode: 0o600,
    });
    const fresh = new CredentialStore(dataDir, immediateLease);

    await expect(fresh.read()).resolves.toEqual(record(1));
    await expect(fresh.replace(record(3))).resolves.toBeUndefined();

    await expect(fresh.read()).resolves.toEqual(record(3));
    expect((await readdir(dataDir)).filter((name) =>
      name.endsWith(".txn") || name.endsWith(".bak")
    )).toEqual([]);
  });

  it.each(["write", "clear"] as const)(
    "recovers a valid v2 absent-canonical transaction before %s",
    async (operation) => {
      const dataDir = await tempDataDir();
      const credentialsPath = path.join(dataDir, "credentials.enc");
      const seed = new CredentialStore(dataDir, immediateLease);
      await seed.replace(record(1));
      const installedCiphertext = await readFile(credentialsPath);
      await seed.clear();
      await writeFile(credentialsPath, installedCiphertext, {
        flag: "wx",
        mode: 0o600,
      });
      await writeV2Marker(dataDir, "6".repeat(32), false);
      const fresh = new CredentialStore(dataDir, immediateLease);
      await expect(fresh.read()).resolves.toBeUndefined();

      if (operation === "write") {
        await expect(fresh.replace(record(2))).resolves.toBeUndefined();
        await expect(fresh.read()).resolves.toEqual(record(2));
      } else {
        await expect(fresh.clear()).resolves.toBeUndefined();
        await expect(fresh.read()).resolves.toBeUndefined();
      }
      expect((await readdir(dataDir)).filter((name) =>
        name.endsWith(".txn") || name.endsWith(".bak")
      )).toEqual([]);
    },
  );

  it("makes no recovery mutation after the recovering lease owner loses ownership", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const seed = new CredentialStore(dataDir, immediateLease);
    await seed.replace(record(1));
    const previousCiphertext = await readFile(credentialsPath);
    await seed.replace(record(2));
    const transaction = await writeV2Marker(
      dataDir,
      "7".repeat(32),
      true,
    );
    await writeFile(transaction.backupPath, previousCiphertext, {
      flag: "wx",
      mode: 0o600,
    });
    const before = await snapshotDataDirectory(dataDir);
    let assertions = 0;
    let ownershipLost = false;
    const postLossMutations: string[] = [];
    const losingLease: CredentialLeaseRunner = (_key, run) => run({
      async assertOwned() {
        assertions += 1;
        if (assertions >= 4) {
          ownershipLost = true;
          throw new Error("credential lease ownership lost");
        }
      },
    });
    const store = new CredentialStore(dataDir, losingLease, {
      async link(existingPath, newPath) {
        if (ownershipLost) postLossMutations.push(`link:${newPath}`);
        await link(existingPath, newPath);
      },
      async rename(source, destination) {
        if (ownershipLost) postLossMutations.push(`rename:${destination}`);
        await rename(source, destination);
      },
      async unlink(target) {
        if (ownershipLost) postLossMutations.push(`unlink:${target}`);
        await unlink(target);
      },
      async syncDirectory(directory) {
        if (ownershipLost) postLossMutations.push(`sync:${directory}`);
      },
    });

    await expect(store.replace(record(3))).rejects.toThrow(
      "credential store write failed",
    );

    expect(postLossMutations).toEqual([]);
    await expect(snapshotDataDirectory(dataDir)).resolves.toEqual(before);
  });

  it("treats a partially written transaction marker as rollback pending", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const backupPath = path.join(dataDir, "credentials.enc.bak");
    const transactionPath = path.join(dataDir, "credentials.txn");
    const store = new CredentialStore(dataDir, immediateLease);
    const initial = record(1);
    await store.replace(initial);
    const initialCiphertext = await readFile(credentialsPath);
    await store.replace(record(2));
    await writeFile(backupPath, initialCiphertext, { mode: 0o600 });
    await writeFile(transactionPath, "roll", { mode: 0o600 });
    const freshStore = new CredentialStore(dataDir, immediateLease);

    await expect(freshStore.read()).resolves.toEqual(initial);
  });

  it("reads the intact canonical record when a marker survives without a backup", async () => {
    const dataDir = await tempDataDir();
    const backupPath = path.join(dataDir, "credentials.enc.bak");
    const transactionPath = path.join(dataDir, "credentials.txn");
    const store = new CredentialStore(dataDir, immediateLease);
    const initial = record(1);
    await store.replace(initial);
    await expect(readFile(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(transactionPath, "rollback-v1\n", { mode: 0o600 });
    const freshStore = new CredentialStore(dataDir, immediateLease);

    await expect(freshStore.read()).resolves.toEqual(initial);
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

  it("restores the exact prior credential when clear is aborted during canonical unlink", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    const ciphertext = await readFile(credentialsPath);
    const unlinkStarted = deferred();
    const unlinkGate = deferred();
    const store = new CredentialStore(dataDir, immediateLease, {
      async unlink(target) {
        if (target === credentialsPath) {
          unlinkStarted.resolve();
          await unlinkGate.promise;
        }
        await unlink(target);
      },
    });
    const controller = new AbortController();

    const clearing = store.clear({ signal: controller.signal });
    await unlinkStarted.promise;
    controller.abort();
    unlinkGate.resolve();

    await expect(clearing).rejects.toThrow("credential store clear failed");
    await expect(readFile(credentialsPath)).resolves.toEqual(ciphertext);
    await expect(new CredentialStore(dataDir, immediateLease).read()).resolves.toEqual(initial);
    expect((await readdir(dataDir)).some((name) => name.endsWith(".bak"))).toBe(false);
  });

  it("restores clear when cancellation arrives during the post-unlink directory sync", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    const ciphertext = await readFile(credentialsPath);
    const syncStarted = deferred();
    const syncGate = deferred();
    let syncCalls = 0;
    const store = new CredentialStore(dataDir, immediateLease, {
      async syncDirectory() {
        syncCalls += 1;
        if (syncCalls === 2) {
          syncStarted.resolve();
          await syncGate.promise;
        }
      },
    });
    const controller = new AbortController();
    const clearing = store.clear({ signal: controller.signal });
    await syncStarted.promise;

    controller.abort();
    syncGate.resolve();

    await expect(clearing).rejects.toThrow("credential store clear failed");
    await expect(readFile(credentialsPath)).resolves.toEqual(ciphertext);
    await expect(new CredentialStore(dataDir, immediateLease).read()).resolves.toEqual(initial);
  });

  it("restores clear when the post-unlink directory sync fails", async () => {
    const dataDir = await tempDataDir();
    const credentialsPath = path.join(dataDir, "credentials.enc");
    const initial = record(1);
    const seedStore = new CredentialStore(dataDir, immediateLease);
    await seedStore.replace(initial);
    const ciphertext = await readFile(credentialsPath);
    let syncCalls = 0;
    const store = new CredentialStore(dataDir, immediateLease, {
      async syncDirectory() {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error("post-unlink sync failed");
      },
    });

    await expect(store.clear()).rejects.toThrow("credential store clear failed");

    await expect(readFile(credentialsPath)).resolves.toEqual(ciphertext);
    await expect(new CredentialStore(dataDir, immediateLease).read()).resolves.toEqual(initial);
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
