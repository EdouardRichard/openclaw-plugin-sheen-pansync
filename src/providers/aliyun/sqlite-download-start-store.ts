import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { PanSyncError } from "../../errors.js";
import {
  DOWNLOAD_START_GUARD_MS,
  DOWNLOAD_START_LIMIT,
  DOWNLOAD_START_WINDOW_MS,
  type DownloadStartReservation,
  type DownloadStartReservationStore,
} from "./download-start-limiter.js";

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 200;
const ACQUISITION_TIMEOUT_MS = 30_000;
const CLOCK_ROLLBACK_TOLERANCE_MS = 5_000;

type WorkerMessage =
  | { type: "granted" }
  | { type: "wait"; waitMs: number }
  | { type: "failed" };

export interface SqliteDownloadStartWorker {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  terminate(): Promise<number>;
}

export type SqliteDownloadStartWorkerFactory = (options: {
  databasePath: string;
  limit: number;
  windowMs: number;
  guardMs: number;
  rollbackToleranceMs: number;
  busyTimeoutMs: number;
  cancellationBuffer: SharedArrayBuffer;
}) => SqliteDownloadStartWorker;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

let database;
let transactionOpen = false;
const cancellation = new Int32Array(workerData.cancellationBuffer);

const cancelled = () => Atomics.load(cancellation, 0) !== 0;
const closeDatabase = () => {
  try {
    if (transactionOpen) database?.exec("ROLLBACK");
  } catch {}
  transactionOpen = false;
  try {
    database?.close();
  } catch {}
  database = undefined;
};
const sendAndClose = (message) => {
  try {
    parentPort.postMessage(message);
  } finally {
    parentPort.close();
  }
};

try {
  if (cancelled()) throw new Error("cancelled");
  database = new DatabaseSync(workerData.databasePath, {
    timeout: workerData.busyTimeoutMs,
  });
  database.exec(
    "CREATE TABLE IF NOT EXISTS download_starts (id INTEGER PRIMARY KEY, started_at_ms INTEGER NOT NULL) STRICT",
  );

  const deadline = performance.now() + workerData.acquisitionTimeoutMs;
  for (;;) {
    if (cancelled()) throw new Error("cancelled");
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error("timed out");
    const busySliceMs = Math.max(
      1,
      Math.min(workerData.busyTimeoutMs, Math.floor(remainingMs)),
    );
    database.exec("PRAGMA busy_timeout = " + busySliceMs);
    try {
      if (cancelled()) throw new Error("cancelled");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      break;
    } catch {
      if (cancelled() || performance.now() >= deadline) {
        throw new Error("acquisition stopped");
      }
    }
  }

  if (cancelled()) throw new Error("cancelled");
  const transactionNowMs = Date.now();
  if (!Number.isFinite(transactionNowMs)) throw new Error("invalid time");
  database
    .prepare("DELETE FROM download_starts WHERE started_at_ms + ? + ? <= ?")
    .run(workerData.windowMs, workerData.guardMs, transactionNowMs);
  const newestRow = database
    .prepare("SELECT MAX(started_at_ms) AS newest FROM download_starts")
    .get();
  const newestValue = newestRow.newest;
  let rollbackWaitMs;
  if (newestValue !== null && newestValue !== undefined) {
    const newest = Number(newestValue);
    if (!Number.isFinite(newest)) throw new Error("invalid newest start");
    const futureSkewMs = newest - transactionNowMs;
    if (futureSkewMs > workerData.rollbackToleranceMs) {
      throw new Error("clock rollback exceeds tolerance");
    }
    if (futureSkewMs > 0) {
      rollbackWaitMs = workerData.windowMs + workerData.guardMs;
    }
  }

  if (rollbackWaitMs !== undefined) {
    if (!Number.isFinite(rollbackWaitMs) || rollbackWaitMs < 0 || cancelled()) {
      throw new Error("invalid rollback wait");
    }
    database.exec("COMMIT");
    transactionOpen = false;
    closeDatabase();
    sendAndClose({ type: "wait", waitMs: rollbackWaitMs });
  } else {
    const countRow = database
      .prepare("SELECT COUNT(*) AS count FROM download_starts")
      .get();
    const count = Number(countRow.count);

    if (count < workerData.limit) {
      if (cancelled()) throw new Error("cancelled");
      database
        .prepare("INSERT INTO download_starts (started_at_ms) VALUES (?)")
        .run(transactionNowMs);
      if (cancelled()) throw new Error("cancelled");
      database.exec("COMMIT");
      transactionOpen = false;
      closeDatabase();
      sendAndClose({ type: "granted" });
    } else {
      const oldestRow = database
        .prepare("SELECT MIN(started_at_ms) AS oldest FROM download_starts")
        .get();
      const oldest = Number(oldestRow.oldest);
      const waitMs = oldest + workerData.windowMs + workerData.guardMs - transactionNowMs;
      if (!Number.isFinite(waitMs) || waitMs < 0 || cancelled()) {
        throw new Error("invalid wait");
      }
      database.exec("COMMIT");
      transactionOpen = false;
      closeDatabase();
      sendAndClose({ type: "wait", waitMs });
    }
  }
} catch {
  closeDatabase();
  sendAndClose({ type: "failed" });
}
`;

function stableDownloadFailure(): PanSyncError {
  return new PanSyncError("DOWNLOAD_FAILED");
}

function isWorkerMessage(candidate: unknown): candidate is WorkerMessage {
  if (typeof candidate !== "object" || candidate === null) return false;
  const message = candidate as { type?: unknown; waitMs?: unknown };
  if (message.type === "granted" || message.type === "failed") return true;
  return message.type === "wait"
    && typeof message.waitMs === "number"
    && Number.isFinite(message.waitMs)
    && message.waitMs >= 0;
}

function defaultWorkerFactory(options: {
  databasePath: string;
  limit: number;
  windowMs: number;
  guardMs: number;
  rollbackToleranceMs: number;
  busyTimeoutMs: number;
  cancellationBuffer: SharedArrayBuffer;
}): SqliteDownloadStartWorker {
  const workerData = {
    ...options,
    acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
  };
  return new Worker(WORKER_SOURCE, {
    eval: true,
    name: "pan-sync-download-start",
    workerData,
  });
}

export function createSqliteWorkerDownloadStartStore(
  databasePath: string,
  options: {
    workerFactory?: SqliteDownloadStartWorkerFactory;
    limit?: number;
    windowMs?: number;
    guardMs?: number;
  } = {},
): DownloadStartReservationStore {
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  const limit = options.limit ?? DOWNLOAD_START_LIMIT;
  const windowMs = options.windowMs ?? DOWNLOAD_START_WINDOW_MS;
  const guardMs = options.guardMs ?? DOWNLOAD_START_GUARD_MS;
  const databaseDirectory = path.dirname(databasePath);

  return {
    async reserve(
      _nowMs: number,
      signal?: AbortSignal,
    ): Promise<DownloadStartReservation> {
      try {
        await mkdir(databaseDirectory, { recursive: true, mode: DIRECTORY_MODE });
        await chmod(databaseDirectory, DIRECTORY_MODE);
      } catch {
        throw stableDownloadFailure();
      }

      const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const cancellation = new Int32Array(cancellationBuffer);
      let worker: SqliteDownloadStartWorker;
      try {
        worker = workerFactory({
          databasePath,
          limit,
          windowMs,
          guardMs,
          rollbackToleranceMs: CLOCK_ROLLBACK_TOLERANCE_MS,
          busyTimeoutMs: BUSY_TIMEOUT_MS,
          cancellationBuffer,
        });
      } catch {
        throw stableDownloadFailure();
      }

      return new Promise<DownloadStartReservation>((resolve, reject) => {
        let closed = false;
        let response: DownloadStartReservation | undefined;
        let terminated = false;

        const cleanup = (): void => {
          worker.off("message", onMessage);
          worker.off("messageerror", onWorkerFailure);
          worker.off("error", onWorkerFailure);
          worker.off("exit", onExit);
          signal?.removeEventListener("abort", onAbort);
        };
        const terminate = (): void => {
          if (terminated) return;
          terminated = true;
          try {
            void worker.terminate();
          } catch {
            // The caller always receives the stable download failure.
          }
        };
        const fail = (): void => {
          if (closed) return;
          closed = true;
          Atomics.store(cancellation, 0, 1);
          Atomics.notify(cancellation, 0);
          cleanup();
          terminate();
          reject(stableDownloadFailure());
        };
        const succeed = async (): Promise<void> => {
          if (closed || response === undefined) return;
          closed = true;
          cleanup();
          try {
            await chmod(databasePath, DATABASE_MODE);
            resolve(response);
          } catch {
            terminate();
            reject(stableDownloadFailure());
          }
        };
        const onMessage = (candidate: unknown): void => {
          if (!isWorkerMessage(candidate) || response !== undefined) {
            fail();
            return;
          }
          if (candidate.type === "failed") {
            fail();
            return;
          }
          response = candidate.type === "granted"
            ? { status: "granted" }
            : { status: "wait", waitMs: candidate.waitMs };
        };
        const onWorkerFailure = (): void => fail();
        const onExit = (code: number): void => {
          if (code !== 0 || response === undefined) {
            fail();
            return;
          }
          void succeed();
        };
        const onAbort = (): void => fail();

        worker.on("message", onMessage);
        worker.on("messageerror", onWorkerFailure);
        worker.on("error", onWorkerFailure);
        worker.on("exit", onExit);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted === true) onAbort();
      });
    },
  };
}
