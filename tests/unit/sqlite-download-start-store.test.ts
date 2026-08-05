import { EventEmitter } from "node:events";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSqliteWorkerDownloadStartStore,
  type SqliteDownloadStartWorker,
  type SqliteDownloadStartWorkerFactory,
} from "../../src/providers/aliyun/sqlite-download-start-store.js";
import { createTempState, octalMode } from "../helpers/temp-state.js";

type WorkerMessage = unknown;

class FakeWorker extends EventEmitter implements SqliteDownloadStartWorker {
  terminateCalls = 0;

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    queueMicrotask(() => this.emit("exit", 1));
    return 1;
  }

  message(message: WorkerMessage): void {
    this.emit("message", message);
  }

  exited(code = 0): void {
    this.emit("exit", code);
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function tempDatabasePath(): Promise<string> {
  const state = await createTempState();
  cleanups.push(state.cleanup);
  return path.join(state.dataDir, "starts", "download-starts.sqlite");
}

function fakeFactory(workers: FakeWorker[]): SqliteDownloadStartWorkerFactory {
  return () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
}

async function createDatabaseFile(databasePath: string): Promise<void> {
  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeFile(databasePath, "", { flag: "wx", mode: 0o666 });
}

async function grant(
  databasePath: string,
  worker: FakeWorker,
): Promise<void> {
  await createDatabaseFile(databasePath);
  worker.message({ type: "granted" });
  worker.exited(0);
}

describe("SQLite download-start reservation store", () => {
  it("adds the private acquisition deadline to default Worker data", async () => {
    const databasePath = await tempDatabasePath();
    let workerData: unknown;
    class CapturingWorker extends EventEmitter {
      constructor(_source: string, options: { workerData: unknown }) {
        super();
        workerData = options.workerData;
      }

      async terminate(): Promise<number> {
        queueMicrotask(() => this.emit("exit", 1));
        return 1;
      }
    }

    vi.resetModules();
    vi.doMock("node:worker_threads", () => ({ Worker: CapturingWorker }));
    try {
      const { createSqliteWorkerDownloadStartStore: createDefaultStore } =
        await import("../../src/providers/aliyun/sqlite-download-start-store.js");
      const controller = new AbortController();
      controller.abort();

      await expect(
        createDefaultStore(databasePath).reserve(1_234_567, controller.signal),
      ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });

      expect(workerData).toEqual({
        databasePath,
        limit: 2,
        windowMs: 60_000,
        guardMs: 250,
        rollbackToleranceMs: 5_000,
        busyTimeoutMs: 200,
        acquisitionTimeoutMs: 30_000,
        cancellationBuffer: expect.any(SharedArrayBuffer),
      });
    } finally {
      vi.doUnmock("node:worker_threads");
      vi.resetModules();
    }
  });

  it("uses the default Worker to atomically grant then reserve a bounded wait", async () => {
    const databasePath = await tempDatabasePath();
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      limit: 1,
    });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 1_000);

    try {
      await expect(store.reserve(100, controller.signal)).resolves.toEqual({
        status: "granted",
      });
    } finally {
      clearTimeout(abortTimer);
    }

    const reservation = await store.reserve(100);
    expect(reservation.status).toBe("wait");
    if (reservation.status === "wait") {
      expect(reservation.waitMs).toBeGreaterThan(0);
      expect(reservation.waitMs).toBeLessThanOrEqual(60_250);
    }
  });

  it("grants two default reservations and makes the third wait within the protected window", async () => {
    const databasePath = await tempDatabasePath();
    const store = createSqliteWorkerDownloadStartStore(databasePath);

    await expect(store.reserve(1)).resolves.toEqual({ status: "granted" });
    await expect(store.reserve(1)).resolves.toEqual({ status: "granted" });
    const third = await store.reserve(1);
    expect(third.status).toBe("wait");
    if (third.status === "wait") {
      expect(third.waitMs).toBeGreaterThan(0);
      expect(third.waitMs).toBeLessThanOrEqual(60_250);
    }
  });

  it("records a fresh timestamp after waiting for a real SQLite lock", async () => {
    const databasePath = await tempDatabasePath();
    await mkdir(path.dirname(databasePath), { recursive: true });
    const lock = new DatabaseSync(databasePath);
    let transactionOpen = false;
    lock.exec(
      "CREATE TABLE download_starts (id INTEGER PRIMARY KEY, started_at_ms INTEGER NOT NULL) STRICT",
    );
    lock.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const preLockRequestMs = Date.now();
    const reservation = createSqliteWorkerDownloadStartStore(databasePath)
      .reserve(preLockRequestMs);

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      lock.exec("COMMIT");
      transactionOpen = false;
      const releasedAtMs = Date.now();

      await expect(reservation).resolves.toEqual({ status: "granted" });
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = reader
          .prepare("SELECT started_at_ms FROM download_starts")
          .get() as { started_at_ms: number };
        expect(Number(row.started_at_ms)).toBeGreaterThanOrEqual(
          releasedAtMs - 50,
        );
        expect(Number(row.started_at_ms)).toBeGreaterThan(preLockRequestMs);
      } finally {
        reader.close();
      }
    } finally {
      if (transactionOpen) lock.exec("ROLLBACK");
      lock.close();
    }
  });

  it("keeps a small future timestamp and returns one full bounded wait", async () => {
    const databasePath = await tempDatabasePath();
    await mkdir(path.dirname(databasePath), { recursive: true });
    const futureStartMs = Date.now() + 2_000;
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE download_starts (id INTEGER PRIMARY KEY, started_at_ms INTEGER NOT NULL) STRICT",
    );
    database
      .prepare("INSERT INTO download_starts (started_at_ms) VALUES (?)")
      .run(futureStartMs);
    database.close();

    await expect(
      createSqliteWorkerDownloadStartStore(databasePath).reserve(1),
    ).resolves.toEqual({ status: "wait", waitMs: 60_250 });

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT started_at_ms FROM download_starts").all(),
      ).toEqual([{ started_at_ms: futureStartMs }]);
    } finally {
      reader.close();
    }
  });

  it("fails closed when a persisted timestamp exceeds the rollback tolerance", async () => {
    const databasePath = await tempDatabasePath();
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE download_starts (id INTEGER PRIMARY KEY, started_at_ms INTEGER NOT NULL) STRICT",
    );
    database
      .prepare("INSERT INTO download_starts (started_at_ms) VALUES (?)")
      .run(Date.now() + 10_000);
    database.close();

    await expect(
      createSqliteWorkerDownloadStartStore(databasePath).reserve(1),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  });

  it("bounds real SQLite lock acquisition at the default deadline", async () => {
    const databasePath = await tempDatabasePath();
    await mkdir(path.dirname(databasePath), { recursive: true });
    const lock = new DatabaseSync(databasePath);
    let lockHeld = false;
    let lockReleased = false;
    const releaseLock = (): void => {
      if (!lockHeld) return;
      lock.exec("ROLLBACK");
      lock.close();
      lockHeld = false;
      lockReleased = true;
    };
    lock.exec(
      "CREATE TABLE download_starts (id INTEGER PRIMARY KEY, started_at_ms INTEGER NOT NULL) STRICT",
    );
    lock.exec("BEGIN IMMEDIATE");
    lockHeld = true;
    const releaseTimer = setTimeout(releaseLock, 32_000);
    const startedAt = Date.now();

    try {
      await expect(
        createSqliteWorkerDownloadStartStore(databasePath).reserve(100),
      ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
      expect(lockReleased).toBe(false);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
    } finally {
      clearTimeout(releaseTimer);
      releaseLock();
    }
  }, 40_000);

  it("passes the database path and exact default Worker options", async () => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    let factoryOptions:
      | {
        databasePath: string;
        limit: number;
        windowMs: number;
        guardMs: number;
        rollbackToleranceMs: number;
        busyTimeoutMs: number;
        cancellationBuffer: SharedArrayBuffer;
      }
      | undefined;
    const workerFactory: SqliteDownloadStartWorkerFactory = (options) => {
      factoryOptions = options;
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      workerFactory,
    });
    const reservation = store.reserve(1_234_567);

    await waitFor(() => workers.length === 1);
    await grant(databasePath, workers[0]!);

    await expect(reservation).resolves.toEqual({ status: "granted" });
    expect(factoryOptions).toEqual({
      databasePath,
      limit: 2,
      windowMs: 60_000,
      guardMs: 250,
      rollbackToleranceMs: 5_000,
      busyTimeoutMs: 200,
      cancellationBuffer: expect.any(SharedArrayBuffer),
    });
  });

  it("maps a granted Worker response to a granted reservation", async () => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      workerFactory: fakeFactory(workers),
    });
    const reservation = store.reserve(1);

    await waitFor(() => workers.length === 1);
    await grant(databasePath, workers[0]!);

    await expect(reservation).resolves.toEqual({ status: "granted" });
  });

  it("maps a wait Worker response to its wait reservation", async () => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      workerFactory: fakeFactory(workers),
    });
    const reservation = store.reserve(1);

    await waitFor(() => workers.length === 1);
    await createDatabaseFile(databasePath);
    workers[0]!.message({ type: "wait", waitMs: 12_345 });
    workers[0]!.exited(0);

    await expect(reservation).resolves.toEqual({ status: "wait", waitMs: 12_345 });
  });

  it.each([
    ["a malformed message", (worker: FakeWorker) => worker.message({ bad: true })],
    ["a duplicate message", (worker: FakeWorker) => {
      worker.message({ type: "granted" });
      worker.message({ type: "granted" });
    }],
    ["a messageerror event", (worker: FakeWorker) => worker.emit("messageerror", new Error("messageerror-CANARY"))],
    ["an error event", (worker: FakeWorker) => worker.emit("error", new Error("error-CANARY"))],
    ["a non-zero exit", (worker: FakeWorker) => worker.exited(1)],
  ])("fails closed after %s", async (_description, trigger) => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      workerFactory: fakeFactory(workers),
    });
    const reservation = store.reserve(1);

    await waitFor(() => workers.length === 1);
    trigger(workers[0]!);

    await expect(reservation).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    await expect(reservation).rejects.not.toThrow("CANARY");
    expect(workers[0]!.terminateCalls).toBeLessThanOrEqual(1);
  });

  it("terminates a Worker when the signal is already aborted", async () => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    const controller = new AbortController();
    controller.abort();
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      workerFactory: fakeFactory(workers),
    });

    await expect(store.reserve(1, controller.signal)).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminateCalls).toBe(1);
  });

  it("terminates an in-flight Worker when the signal aborts", async () => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    const controller = new AbortController();
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      workerFactory: fakeFactory(workers),
    });
    const reservation = store.reserve(1, controller.signal);

    await waitFor(() => workers.length === 1);
    controller.abort();

    await expect(reservation).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(workers[0]!.terminateCalls).toBe(1);
  });

  it("uses private directory and database modes where POSIX modes apply", async () => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    const store = createSqliteWorkerDownloadStartStore(databasePath, {
      workerFactory: fakeFactory(workers),
    });
    const reservation = store.reserve(1);

    await waitFor(() => workers.length === 1);
    await grant(databasePath, workers[0]!);

    await expect(reservation).resolves.toEqual({ status: "granted" });
    expect((await stat(path.dirname(databasePath))).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(await octalMode(path.dirname(databasePath))).toBe("700");
      expect(await octalMode(databasePath)).toBe("600");
    }
  });
});
