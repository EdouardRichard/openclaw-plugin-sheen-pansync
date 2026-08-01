import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  CredentialLeaseContext,
  CredentialLeaseRunner,
} from "./store.js";

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 200;
const ACQUISITION_TIMEOUT_MS = 30_000;
const SAFE_KEY = /^[A-Za-z0-9._-]{1,64}$/u;
const UNAVAILABLE = "credential lease unavailable";
const OWNERSHIP_LOST = "credential lease ownership lost";

type WorkerCommand = { type: "release" };
type WorkerMessage = {
  type: "acquired" | "failed" | "released" | "release-failed";
};

export interface SqliteLeaseWorker {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(message: WorkerCommand): void;
  terminate(): Promise<number>;
}

export type SqliteLeaseWorkerFactory = (options: {
  databasePath: string;
  busyTimeoutMs: number;
  acquisitionTimeoutMs: number;
  cancellationBuffer: SharedArrayBuffer;
}) => SqliteLeaseWorker;

export type SqliteWorkerCredentialLeaseOptions = {
  workerFactory?: SqliteLeaseWorkerFactory;
};

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

let database;
const sendAndClose = (type) => {
  try {
    parentPort.postMessage({ type });
  } finally {
    parentPort.close();
  }
};

try {
  database = new DatabaseSync(workerData.databasePath, {
    timeout: workerData.busyTimeoutMs,
  });
  const cancellation = new Int32Array(workerData.cancellationBuffer);
  const deadline = performance.now() + workerData.acquisitionTimeoutMs;
  for (;;) {
    if (Atomics.load(cancellation, 0) !== 0) {
      throw new Error("cancelled");
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error("timed out");
    const busySliceMs = Math.max(
      1,
      Math.min(workerData.busyTimeoutMs, Math.floor(remainingMs)),
    );
    database.exec("PRAGMA busy_timeout = " + busySliceMs);
    try {
      database.exec("BEGIN IMMEDIATE");
      break;
    } catch {
      if (
        Atomics.load(cancellation, 0) !== 0
        || performance.now() >= deadline
      ) {
        throw new Error("acquisition stopped");
      }
    }
  }
  if (Atomics.load(cancellation, 0) !== 0) {
    database.exec("ROLLBACK");
    throw new Error("cancelled");
  }
  parentPort.postMessage({ type: "acquired" });
  parentPort.once("message", (message) => {
    if (message?.type !== "release") return;
    try {
      database.exec("ROLLBACK");
      database.close();
      database = undefined;
      sendAndClose("released");
    } catch {
      try {
        database?.close();
      } catch {}
      database = undefined;
      sendAndClose("release-failed");
    }
  });
} catch {
  try {
    database?.close();
  } catch {}
  database = undefined;
  sendAndClose("failed");
}
`;

function stableUnavailable(): Error {
  return new Error(UNAVAILABLE);
}

function stableOwnershipLost(): Error {
  return new Error(OWNERSHIP_LOST);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isWorkerMessage(candidate: unknown): candidate is WorkerMessage {
  if (typeof candidate !== "object" || candidate === null) return false;
  const type = (candidate as { type?: unknown }).type;
  return type === "acquired"
    || type === "failed"
    || type === "released"
    || type === "release-failed";
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function defaultWorkerFactory(options: {
  databasePath: string;
  busyTimeoutMs: number;
  acquisitionTimeoutMs: number;
  cancellationBuffer: SharedArrayBuffer;
}): SqliteLeaseWorker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    name: "pan-sync-lease",
    workerData: options,
  });
}

export function createSqliteWorkerCredentialLeaseRunner(
  databasePath: string,
  options: SqliteWorkerCredentialLeaseOptions = {},
): CredentialLeaseRunner {
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  const lockDirectory = path.dirname(databasePath);

  return async <T>(
    key: string,
    run: (lease: CredentialLeaseContext) => Promise<T>,
    leaseOptions: { signal?: AbortSignal } = {},
  ): Promise<T> => {
    if (!SAFE_KEY.test(key) || isAborted(leaseOptions.signal)) {
      throw stableUnavailable();
    }

    try {
      await mkdir(lockDirectory, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(lockDirectory, DIRECTORY_MODE);
    } catch {
      throw stableUnavailable();
    }
    if (isAborted(leaseOptions.signal)) throw stableUnavailable();

    let worker: SqliteLeaseWorker;
    const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancellation = new Int32Array(cancellationBuffer);
    try {
      worker = workerFactory({
        databasePath,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
        cancellationBuffer,
      });
    } catch {
      throw stableUnavailable();
    }

    type Phase = "acquiring" | "acquired" | "releasing" | "closed";
    let phase: Phase = "acquiring";
    let ownershipLost = false;
    let protocolFailed = false;
    let exited = false;
    let exitCode: number | undefined;
    let termination: Promise<void> | undefined;
    const acquisition = deferred<"acquired" | "failed">();
    const release = deferred<"released" | "failed">();
    const workerExit = deferred<void>();

    const forceTerminate = (): Promise<void> => {
      if (termination !== undefined) return termination;
      termination = (async () => {
        if (exited) return;
        try {
          await worker.terminate();
        } catch {
          // The stable caller result never exposes Worker/native failures.
        }
        if (!exited) await workerExit.promise;
      })();
      return termination;
    };

    const onProtocolFailure = (): void => {
      ownershipLost = true;
      protocolFailed = true;
      if (phase === "acquiring") acquisition.resolve("failed");
      if (phase === "releasing") release.resolve("failed");
      if (phase !== "acquired") void forceTerminate();
    };
    const onMessage = (candidate: unknown): void => {
      if (!isWorkerMessage(candidate)) {
        onProtocolFailure();
        return;
      }
      if (candidate.type === "acquired" && phase === "acquiring") {
        phase = "acquired";
        acquisition.resolve("acquired");
        return;
      }
      if (candidate.type === "failed" && phase === "acquiring") {
        ownershipLost = true;
        acquisition.resolve("failed");
        return;
      }
      if (candidate.type === "released" && phase === "releasing") {
        release.resolve("released");
        return;
      }
      if (
        candidate.type === "release-failed"
        && phase === "releasing"
      ) {
        release.resolve("failed");
        return;
      }
      onProtocolFailure();
    };
    const onWorkerFailure = (): void => {
      ownershipLost = true;
      if (phase === "acquiring") acquisition.resolve("failed");
      if (phase === "releasing") release.resolve("failed");
    };
    const onExit = (code: number): void => {
      exited = true;
      exitCode = code;
      if (phase === "acquiring") {
        ownershipLost = true;
        acquisition.resolve("failed");
      } else if (phase === "acquired") {
        ownershipLost = true;
      } else if (phase === "releasing") {
        release.resolve("failed");
      }
      workerExit.resolve();
    };
    const onAbort = (): void => {
      Atomics.store(cancellation, 0, 1);
      Atomics.notify(cancellation, 0);
      ownershipLost = true;
      if (phase === "acquiring") {
        acquisition.resolve("failed");
        void forceTerminate();
      }
    };
    const cleanupListeners = (): void => {
      worker.off("message", onMessage);
      worker.off("messageerror", onWorkerFailure);
      worker.off("error", onWorkerFailure);
      worker.off("exit", onExit);
      leaseOptions.signal?.removeEventListener("abort", onAbort);
    };

    worker.on("message", onMessage);
    worker.on("messageerror", onWorkerFailure);
    worker.on("error", onWorkerFailure);
    worker.on("exit", onExit);
    leaseOptions.signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted(leaseOptions.signal)) onAbort();

    const acquisitionResult = await acquisition.promise;
    if (acquisitionResult === "failed") {
      await forceTerminate();
      phase = "closed";
      cleanupListeners();
      throw stableUnavailable();
    }

    try {
      await chmod(databasePath, DATABASE_MODE);
    } catch {
      ownershipLost = true;
      await forceTerminate();
      phase = "closed";
      cleanupListeners();
      throw stableUnavailable();
    }

    const assertOwned = async (): Promise<void> => {
      if (
        phase !== "acquired"
        || ownershipLost
        || exited
        || isAborted(leaseOptions.signal)
      ) {
        throw stableOwnershipLost();
      }
    };

    let result: T | undefined;
    let callbackError: unknown;
    let resultBoundaryOwned = false;
    try {
      result = await run({ assertOwned });
      await assertOwned();
      resultBoundaryOwned = true;
    } catch (error) {
      callbackError = error;
    }

    let releaseFailed = false;
    if (!exited) {
      phase = "releasing";
      if (protocolFailed) {
        releaseFailed = true;
        await forceTerminate();
      } else {
        try {
          worker.postMessage({ type: "release" });
        } catch {
          release.resolve("failed");
        }
        const releaseResult = await release.promise;
        if (releaseResult === "released") {
          if (!exited) await workerExit.promise;
          releaseFailed = exitCode !== 0;
        } else {
          releaseFailed = true;
          await forceTerminate();
        }
      }
    }

    phase = "closed";
    cleanupListeners();

    if (resultBoundaryOwned) {
      // The Vault result is already definitive. Cleanup failure is handled by
      // forced Worker termination and must not turn success into ambiguity.
      return result as T;
    }
    if (ownershipLost || isAborted(leaseOptions.signal)) {
      throw stableUnavailable();
    }
    if (callbackError !== undefined) throw callbackError;
    if (releaseFailed) throw stableUnavailable();
    return result as T;
  };
}
