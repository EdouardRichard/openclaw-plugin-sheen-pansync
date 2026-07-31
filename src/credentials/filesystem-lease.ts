import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type {
  CredentialLeaseContext,
  CredentialLeaseRunner,
} from "./store.js";

const DIRECTORY_MODE = 0o700;
const LOCK_MODE = 0o600;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_MS = 50;
const HEARTBEAT_RENAME_RETRY_MS = 5;
const HEARTBEAT_RENAME_ATTEMPTS = 5;
const OWNER_BYTES = 32;
const SAFE_KEY = /^[A-Za-z0-9._-]{1,64}$/u;
const UNAVAILABLE = "credential lease unavailable";
const OWNERSHIP_LOST = "credential lease ownership lost";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type ProcessStatus = "alive" | "dead" | "indeterminate";

type LeaseRecord = {
  formatVersion: 1;
  ownerToken: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
};

export type FilesystemCredentialLeaseOptions = {
  clock?: () => number;
  randomBytes?: (size: number) => Buffer;
  pid?: number;
  processStatus?: (pid: number) => ProcessStatus;
  heartbeatMs?: number;
  staleMs?: number;
  waitTimeoutMs?: number;
  retryMs?: number;
  delay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  scheduleHeartbeat?: (callback: () => void, delayMs: number) => unknown;
  cancelHeartbeat?: (timer: unknown) => void;
  beforePublish?: () => void | Promise<void>;
};

function stableUnavailable(): Error {
  return new Error(UNAVAILABLE);
}

function stableOwnershipLost(): Error {
  return new Error(OWNERSHIP_LOST);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code
  );
}

function isTransientRenameError(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EPERM"].some((code) =>
    hasErrorCode(error, code)
  );
}

function defaultProcessStatus(pid: number): ProcessStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return hasErrorCode(error, "ESRCH") ? "dead" : "indeterminate";
  }
}

function defaultDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(stableUnavailable());
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(stableUnavailable());
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function parseRecord(serialized: string): LeaseRecord | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
  ) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  if (
    record.formatVersion !== 1
    || typeof record.ownerToken !== "string"
    || record.ownerToken.length < 1
    || record.ownerToken.length > 256
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || typeof record.acquiredAt !== "number"
    || !Number.isFinite(record.acquiredAt)
    || typeof record.heartbeatAt !== "number"
    || !Number.isFinite(record.heartbeatAt)
  ) {
    return undefined;
  }
  return {
    formatVersion: 1,
    ownerToken: record.ownerToken,
    pid: record.pid as number,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
  };
}

async function readRegularRecord(target: string): Promise<LeaseRecord | undefined> {
  const handle = await open(target, "r");
  try {
    const details = await handle.stat();
    if (!details.isFile()) return undefined;
    return parseRecord(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.ino !== 0 || left.dev !== 0)
  );
}

async function writeRecord(
  handle: FileHandle,
  record: LeaseRecord,
): Promise<void> {
  await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  await handle.sync();
}

function sanitizedDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function createFilesystemCredentialLeaseRunner(
  lockDir: string,
  options: FilesystemCredentialLeaseOptions = {},
): CredentialLeaseRunner {
  const clock = options.clock ?? Date.now;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const pid = options.pid ?? process.pid;
  const processStatus = options.processStatus ?? defaultProcessStatus;
  const heartbeatMs = sanitizedDuration(
    options.heartbeatMs,
    DEFAULT_HEARTBEAT_MS,
  );
  const staleMs = sanitizedDuration(options.staleMs, DEFAULT_STALE_MS);
  const waitTimeoutMs = sanitizedDuration(
    options.waitTimeoutMs,
    DEFAULT_WAIT_TIMEOUT_MS,
  );
  const retryMs = sanitizedDuration(options.retryMs, DEFAULT_RETRY_MS);
  const delay = options.delay ?? defaultDelay;
  const scheduleHeartbeat = options.scheduleHeartbeat
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelHeartbeat = options.cancelHeartbeat
    ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const beforePublish = options.beforePublish ?? (() => undefined);

  const recoveryPath = (key: string): string => path.join(
    lockDir,
    `.${key}.${randomBytes(OWNER_BYTES).toString("base64url")}.stale`,
  );

  const tryRecover = async (
    target: string,
    key: string,
  ): Promise<boolean> => {
    let observed: LeaseRecord | undefined;
    try {
      observed = await readRegularRecord(target);
    } catch (error) {
      return hasErrorCode(error, "ENOENT");
    }
    if (
      observed === undefined
      || clock() - observed.heartbeatAt < staleMs
      || processStatus(observed.pid) !== "dead"
    ) {
      return false;
    }

    const quarantine = recoveryPath(key);
    try {
      await link(target, quarantine);
    } catch (error) {
      return hasErrorCode(error, "ENOENT");
    }
    try {
      const quarantined = await readRegularRecord(quarantine);
      if (quarantined?.ownerToken !== observed.ownerToken) {
        return false;
      }
      const [currentIdentity, quarantineIdentity] = await Promise.all([
        lstat(target),
        lstat(quarantine),
      ]);
      if (!sameFile(currentIdentity, quarantineIdentity)) {
        return false;
      }
      await unlink(target);
      return true;
    } catch (error) {
      return hasErrorCode(error, "ENOENT");
    } finally {
      await unlink(quarantine).catch(() => undefined);
    }
  };

  return async <T>(
    key: string,
    run: (lease: CredentialLeaseContext) => Promise<T>,
    leaseOptions: { signal?: AbortSignal } = {},
  ): Promise<T> => {
    if (!SAFE_KEY.test(key) || isAborted(leaseOptions.signal)) {
      throw stableUnavailable();
    }

    try {
      await mkdir(lockDir, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(lockDir, DIRECTORY_MODE);
    } catch {
      throw stableUnavailable();
    }

    const target = path.join(lockDir, `${key}.lock`);
    const startedAt = clock();
    const ownerToken = (() => {
      try {
        const generated = randomBytes(OWNER_BYTES);
        if (generated.length !== OWNER_BYTES) throw stableUnavailable();
        return generated.toString("base64url");
      } catch {
        throw stableUnavailable();
      }
    })();
    let record: LeaseRecord | undefined;

    while (record === undefined) {
      const now = clock();
      const candidate: LeaseRecord = {
        formatVersion: 1,
        ownerToken,
        pid,
        acquiredAt: now,
        heartbeatAt: now,
      };
      const temporary = path.join(
        lockDir,
        `.${key}.${ownerToken}.acquire`,
      );
      let handle: FileHandle | undefined;
      let publicationAttempted = false;
      let acquisitionError: unknown;
      try {
        handle = await open(temporary, "wx", LOCK_MODE);
        await writeRecord(handle, candidate);
        await chmod(temporary, LOCK_MODE);
        await handle.close();
        handle = undefined;
        await beforePublish();
        publicationAttempted = true;
        await link(temporary, target);
        record = candidate;
      } catch (error) {
        acquisitionError = error;
      } finally {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
        }
        await unlink(temporary).catch(() => undefined);
      }
      if (record !== undefined) {
        break;
      }
      if (
        !publicationAttempted
        || !hasErrorCode(acquisitionError, "EEXIST")
      ) {
        throw stableUnavailable();
      }

      if (await tryRecover(target, key)) continue;
      if (clock() - startedAt >= waitTimeoutMs) {
        throw stableUnavailable();
      }
      try {
        await delay(retryMs, leaseOptions.signal);
      } catch {
        throw stableUnavailable();
      }
      if (isAborted(leaseOptions.signal)) {
        throw stableUnavailable();
      }
    }

    const assertOwned = async (): Promise<void> => {
      try {
        const current = await readRegularRecord(target);
        if (current?.ownerToken !== ownerToken) {
          throw stableOwnershipLost();
        }
      } catch (error) {
        if (error instanceof Error && error.message === OWNERSHIP_LOST) {
          throw error;
        }
        throw stableOwnershipLost();
      }
    };

    const heartbeat = async (): Promise<void> => {
      await assertOwned();
      const temporary = path.join(
        lockDir,
        `.${key}.${ownerToken}.heartbeat`,
      );
      let handle: FileHandle | undefined;
      try {
        handle = await open(temporary, "wx", LOCK_MODE);
        await writeRecord(handle, {
          ...(record as LeaseRecord),
          heartbeatAt: clock(),
        });
        await chmod(temporary, LOCK_MODE);
        await handle.close();
        handle = undefined;
        await assertOwned();
        for (let attempt = 1; attempt <= HEARTBEAT_RENAME_ATTEMPTS; attempt += 1) {
          try {
            await rename(temporary, target);
            break;
          } catch (error) {
            if (
              attempt === HEARTBEAT_RENAME_ATTEMPTS
              || !isTransientRenameError(error)
            ) {
              throw error;
            }
            await delay(HEARTBEAT_RENAME_RETRY_MS);
          }
        }
        record = await readRegularRecord(target) ?? record;
      } finally {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
        }
        await unlink(temporary).catch(() => undefined);
      }
    };

    let heartbeatTimer: unknown;
    let heartbeatInFlight: Promise<void> | undefined;
    let heartbeatFailure: Error | undefined;
    let heartbeatStopped = false;
    const scheduleNextHeartbeat = (): void => {
      if (heartbeatStopped) return;
      heartbeatTimer = scheduleHeartbeat(() => {
        heartbeatTimer = undefined;
        heartbeatInFlight = heartbeat().catch(() => {
          heartbeatFailure = stableOwnershipLost();
          heartbeatStopped = true;
        }).finally(() => {
          heartbeatInFlight = undefined;
          scheduleNextHeartbeat();
        });
      }, heartbeatMs);
    };
    scheduleNextHeartbeat();

    const stopHeartbeat = async (): Promise<void> => {
      heartbeatStopped = true;
      if (heartbeatTimer !== undefined) {
        cancelHeartbeat(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      await heartbeatInFlight;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
    };

    const release = async (): Promise<void> => {
      const proof = path.join(
        lockDir,
        `.${key}.${ownerToken}.release`,
      );
      try {
        await link(target, proof);
        const proofRecord = await readRegularRecord(proof);
        if (proofRecord?.ownerToken !== ownerToken) {
          throw stableOwnershipLost();
        }
        const [currentIdentity, proofIdentity] = await Promise.all([
          lstat(target),
          lstat(proof),
        ]);
        if (!sameFile(currentIdentity, proofIdentity)) {
          throw stableOwnershipLost();
        }
        await unlink(target);
      } catch (error) {
        if (error instanceof Error && error.message === OWNERSHIP_LOST) {
          throw error;
        }
        throw stableOwnershipLost();
      } finally {
        await unlink(proof).catch(() => undefined);
      }
    };

    let result: T | undefined;
    let callbackError: unknown;
    try {
      result = await run({ assertOwned });
    } catch (error) {
      callbackError = error;
    }

    let heartbeatStopError: unknown;
    try {
      await stopHeartbeat();
    } catch (error) {
      heartbeatStopError = error;
    }
    let releaseError: unknown;
    try {
      await release();
    } catch (error) {
      releaseError = error;
    }

    if (heartbeatStopError !== undefined) throw heartbeatStopError;
    if (releaseError !== undefined) throw releaseError;
    if (callbackError !== undefined) throw callbackError;
    return result as T;
  };
}
