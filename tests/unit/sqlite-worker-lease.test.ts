import { EventEmitter } from "node:events";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteWorkerCredentialLeaseRunner,
  type SqliteLeaseWorker,
  type SqliteLeaseWorkerFactory,
} from "../../src/credentials/sqlite-worker-lease.js";
import { createTempState, octalMode } from "../helpers/temp-state.js";

type WorkerMessage = { type: string };

class FakeWorker extends EventEmitter implements SqliteLeaseWorker {
  readonly posted: WorkerMessage[] = [];
  terminateCalls = 0;

  postMessage(message: WorkerMessage): void {
    this.posted.push(message);
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    queueMicrotask(() => this.emit("exit", 1));
    return 1;
  }

  message(type: string): void {
    this.emit("message", { type });
  }

  exited(code = 0): void {
    this.emit("exit", code);
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  const databasePath = path.join(state.dataDir, "locks", "lease.sqlite");
  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeFile(databasePath, "", { flag: "wx", mode: 0o666 });
  return databasePath;
}

function fakeFactory(workers: FakeWorker[]): SqliteLeaseWorkerFactory {
  return () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
}

function listenerCount(worker: FakeWorker): number {
  return ["message", "messageerror", "error", "exit"].reduce(
    (count, event) => count + worker.listenerCount(event),
    0,
  );
}

describe("SQLite Worker credential lease", () => {
  it("keeps a waiter alive beyond a near-timeout refresh and commit", async () => {
    const workers: FakeWorker[] = [];
    const acquisitionBudgets: number[] = [];
    const workerFactory: SqliteLeaseWorkerFactory = (options) => {
      acquisitionBudgets.push(options.acquisitionTimeoutMs);
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory },
    );
    const allowWinnerCommit = deferred();
    let winnerEntered = false;
    let waiterEntered = false;

    const winner = runner("aliyun-token-refresh", async () => {
      winnerEntered = true;
      await allowWinnerCommit.promise;
      return "winner";
    });
    await waitFor(() => workers.length === 1);
    workers[0]!.message("acquired");
    await waitFor(() => winnerEntered);

    const waiter = runner("aliyun-token-refresh", async () => {
      waiterEntered = true;
      return "waiter";
    });
    const waiterOutcome = waiter.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await waitFor(() => workers.length === 2);

    const fullRefreshCriticalSectionMs = 15_001;
    if (acquisitionBudgets[1]! <= fullRefreshCriticalSectionMs) {
      workers[1]!.message("failed");
    }
    allowWinnerCommit.resolve();
    await waitFor(() => workers[0]!.posted.some(({ type }) => type === "release"));
    workers[0]!.message("released");
    workers[0]!.exited(0);
    await expect(winner).resolves.toBe("winner");

    if (acquisitionBudgets[1]! > fullRefreshCriticalSectionMs) {
      workers[1]!.message("acquired");
      await waitFor(() => workers[1]!.posted.some(({ type }) => type === "release"));
      workers[1]!.message("released");
      workers[1]!.exited(0);
    }

    await expect(waiterOutcome).resolves.toEqual({
      status: "fulfilled",
      value: "waiter",
    });
    expect(waiterEntered).toBe(true);
  });

  it("starts the callback only after acquisition and resolves after rollback, close, and Worker exit", async () => {
    const workers: FakeWorker[] = [];
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory: fakeFactory(workers) },
    );
    let entered = false;
    const running = runner("credentials", async (lease) => {
      entered = true;
      await lease.assertOwned();
      return "callback-result";
    });
    await waitFor(() => workers.length === 1);
    const worker = workers[0]!;

    expect(entered).toBe(false);
    worker.message("acquired");
    await waitFor(() => worker.posted.some(({ type }) => type === "release"));
    expect(entered).toBe(true);
    let settled = false;
    void running.finally(() => {
      settled = true;
    });
    worker.message("released");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    worker.exited(0);

    await expect(running).resolves.toBe("callback-result");
    expect(listenerCount(worker)).toBe(0);
  });

  it("terminates an acquiring Worker promptly when the caller aborts", async () => {
    const workers: FakeWorker[] = [];
    const controller = new AbortController();
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory: fakeFactory(workers) },
    );
    let entered = false;
    const running = runner("credentials", async () => {
      entered = true;
    }, { signal: controller.signal });
    await waitFor(() => workers.length === 1);
    const worker = workers[0]!;

    controller.abort(new Error("abort-path-CANARY"));

    await expect(running).rejects.toThrow("credential lease unavailable");
    expect(worker.terminateCalls).toBe(1);
    expect(entered).toBe(false);
    expect(listenerCount(worker)).toBe(0);
  });

  it("aborts acquired ownership but keeps the transaction alive until the callback unwinds", async () => {
    const workers: FakeWorker[] = [];
    const controller = new AbortController();
    const unwind = deferred();
    const ownershipChecked = deferred();
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory: fakeFactory(workers) },
    );
    const running = runner("credentials", async (lease) => {
      await unwind.promise;
      await expect(lease.assertOwned()).rejects.toThrow(
        "credential lease ownership lost",
      );
      ownershipChecked.resolve();
    }, { signal: controller.signal });
    await waitFor(() => workers.length === 1);
    const worker = workers[0]!;
    worker.message("acquired");
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(worker.terminateCalls).toBe(0);
    expect(worker.posted).toEqual([]);
    unwind.resolve();
    await ownershipChecked.promise;
    await waitFor(() => worker.posted.some(({ type }) => type === "release"));
    worker.message("released");
    worker.exited(0);

    await expect(running).rejects.toThrow("credential lease unavailable");
    expect(worker.terminateCalls).toBe(0);
    expect(listenerCount(worker)).toBe(0);
  });

  it.each([
    ["a malformed message", { malformed: true }],
    ["an out-of-order known message", { type: "released" }],
  ])("keeps the transaction alive until the callback unwinds after %s", async (
    _description,
    invalidMessage,
  ) => {
    const workers: FakeWorker[] = [];
    const unwind = deferred();
    const ownershipChecked = deferred();
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory: fakeFactory(workers) },
    );
    const running = runner("credentials", async (lease) => {
      await unwind.promise;
      await expect(lease.assertOwned()).rejects.toThrow(
        "credential lease ownership lost",
      );
      ownershipChecked.resolve();
    });
    const rejection = running.catch((error: unknown) => error);
    await waitFor(() => workers.length === 1);
    const worker = workers[0]!;
    worker.message("acquired");
    worker.emit("message", invalidMessage);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(worker.terminateCalls).toBe(0);
    expect(worker.posted).toEqual([]);
    unwind.resolve();
    await ownershipChecked.promise;
    await waitFor(() => worker.terminateCalls === 1);

    await expect(rejection).resolves.toMatchObject({
      message: "credential lease unavailable",
    });
    expect(worker.posted).toEqual([]);
    expect(listenerCount(worker)).toBe(0);
  });

  it.each(["error", "exit"] as const)(
    "fails closed when an acquired Worker emits an unexpected %s",
    async (failureEvent) => {
      const workers: FakeWorker[] = [];
      const continueCallback = deferred();
      const runner = createSqliteWorkerCredentialLeaseRunner(
        await tempDatabasePath(),
        { workerFactory: fakeFactory(workers) },
      );
      const running = runner("credentials", async (lease) => {
        await continueCallback.promise;
        await lease.assertOwned();
      });
      await waitFor(() => workers.length === 1);
      const worker = workers[0]!;
      worker.message("acquired");
      if (failureEvent === "error") {
        worker.emit("error", new Error("native-worker-path-CANARY"));
        worker.exited(1);
      } else {
        worker.exited(1);
      }
      continueCallback.resolve();

      await expect(running).rejects.toThrow("credential lease unavailable");
      await expect(running).rejects.not.toThrow("native-worker-path-CANARY");
      expect(listenerCount(worker)).toBe(0);
    },
  );

  it("treats callback completion as the result boundary and force-terminates on release failure", async () => {
    const workers: FakeWorker[] = [];
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory: fakeFactory(workers) },
    );
    const running = runner("credentials", async (lease) => {
      await lease.assertOwned();
      return "committed-result";
    });
    await waitFor(() => workers.length === 1);
    const worker = workers[0]!;
    worker.message("acquired");
    await waitFor(() => worker.posted.some(({ type }) => type === "release"));
    worker.message("release-failed");

    await expect(running).resolves.toBe("committed-result");
    expect(worker.terminateCalls).toBe(1);
    expect(listenerCount(worker)).toBe(0);
  });

  it("preserves a callback error while still releasing the Worker transaction", async () => {
    const workers: FakeWorker[] = [];
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory: fakeFactory(workers) },
    );
    const running = runner("credentials", async () => {
      throw new Error("callback-CANARY");
    });
    await waitFor(() => workers.length === 1);
    const worker = workers[0]!;
    worker.message("acquired");
    await waitFor(() => worker.posted.some(({ type }) => type === "release"));
    worker.message("released");
    worker.exited(0);

    await expect(running).rejects.toThrow("callback-CANARY");
    expect(listenerCount(worker)).toBe(0);
  });

  it("requests private directory and database modes before entering the callback", async () => {
    const databasePath = await tempDatabasePath();
    const workers: FakeWorker[] = [];
    let factoryOptions:
      | {
        databasePath: string;
        busyTimeoutMs: number;
        acquisitionTimeoutMs: number;
        cancellationBuffer: SharedArrayBuffer;
      }
      | undefined;
    const workerFactory: SqliteLeaseWorkerFactory = (options) => {
      factoryOptions = options;
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const runner = createSqliteWorkerCredentialLeaseRunner(databasePath, {
      workerFactory,
    });
    const running = runner("credentials", async () => {
      expect((await stat(path.dirname(databasePath))).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(await octalMode(path.dirname(databasePath))).toBe("700");
        expect(await octalMode(databasePath)).toBe("600");
      }
    });
    await waitFor(() => workers.length === 1);
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(databasePath, "", { mode: 0o666 });
    const worker = workers[0]!;
    worker.message("acquired");
    await waitFor(() => worker.posted.some(({ type }) => type === "release"));
    worker.message("released");
    worker.exited(0);

    await running;
    expect(factoryOptions).toEqual({
      databasePath,
      busyTimeoutMs: 200,
      acquisitionTimeoutMs: 30_000,
      cancellationBuffer: expect.any(SharedArrayBuffer),
    });
  });

  it("rejects unsafe lease keys without constructing a Worker", async () => {
    const workers: FakeWorker[] = [];
    const runner = createSqliteWorkerCredentialLeaseRunner(
      await tempDatabasePath(),
      { workerFactory: fakeFactory(workers) },
    );

    await expect(
      runner("../credentials", async () => undefined),
    ).rejects.toThrow("credential lease unavailable");
    expect(workers).toEqual([]);
  });
});
