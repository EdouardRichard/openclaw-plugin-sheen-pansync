import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFilesystemCredentialLeaseRunner,
  type FilesystemCredentialLeaseOptions,
} from "../../src/credentials/filesystem-lease.js";
import { createTempState, octalMode } from "../helpers/temp-state.js";

type LeaseRecord = {
  formatVersion: 1;
  ownerToken: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function tempLockDir(): Promise<string> {
  const state = await createTempState();
  cleanups.push(state.cleanup);
  return path.join(state.dataDir, "locks");
}

function lockPath(lockDir: string): string {
  return path.join(lockDir, "credentials.lock");
}

async function readLock(lockDir: string): Promise<LeaseRecord> {
  return JSON.parse(await readFile(lockPath(lockDir), "utf8")) as LeaseRecord;
}

async function writeLock(
  lockDir: string,
  record: LeaseRecord,
): Promise<void> {
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  await writeFile(lockPath(lockDir), `${JSON.stringify(record)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deterministicTimeoutOptions(
  processStatus: FilesystemCredentialLeaseOptions["processStatus"],
): FilesystemCredentialLeaseOptions {
  let now = 100_000;
  return {
    clock: () => now,
    ...(processStatus === undefined ? {} : { processStatus }),
    retryMs: 5,
    waitTimeoutMs: 15,
    delay: async (delayMs, signal) => {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      now += delayMs;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("filesystem credential lease", () => {
  it("serializes independent runner instances and records a private random owner", async () => {
    const lockDir = await tempLockDir();
    const first = createFilesystemCredentialLeaseRunner(lockDir, {
      retryMs: 5,
    });
    const second = createFilesystemCredentialLeaseRunner(lockDir, {
      retryMs: 5,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    let firstRecord: LeaseRecord | undefined;

    const holding = first("credentials", async () => {
      order.push("first-enter");
      firstRecord = await readLock(lockDir);
      await firstGate;
      order.push("first-exit");
    });
    await waitFor(() => order.includes("first-enter"));
    const waiting = second("credentials", async () => {
      order.push("second-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(order).toEqual(["first-enter"]);
    expect(firstRecord).toEqual(expect.objectContaining({
      formatVersion: 1,
      pid: process.pid,
      acquiredAt: expect.any(Number),
      heartbeatAt: expect.any(Number),
      ownerToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    }));
    if (process.platform !== "win32") {
      expect(await octalMode(lockDir)).toBe("700");
      expect(await octalMode(lockPath(lockDir))).toBe("600");
    }

    releaseFirst();
    await Promise.all([holding, waiting]);

    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    await expect(stat(lockPath(lockDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(lockDir)).resolves.toEqual([]);
  });

  it("recovers a stale lease only after its recorded PID is confirmed dead", async () => {
    const lockDir = await tempLockDir();
    await writeLock(lockDir, {
      formatVersion: 1,
      ownerToken: "stale-owner",
      pid: 424_242,
      acquiredAt: 1,
      heartbeatAt: 1,
    });
    const statuses: number[] = [];
    const runner = createFilesystemCredentialLeaseRunner(lockDir, {
      clock: () => 100_000,
      processStatus(pid) {
        statuses.push(pid);
        return "dead";
      },
      randomBytes: () => Buffer.alloc(32, 7),
    });

    await expect(runner("credentials", async () => "acquired")).resolves.toBe(
      "acquired",
    );

    expect(statuses).toEqual([424_242, 424_242]);
    await expect(stat(lockPath(lockDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("exposes the validated stale-recovery boundary for deterministic race tests", async () => {
    const lockDir = await tempLockDir();
    await writeLock(lockDir, {
      formatVersion: 1,
      ownerToken: "stale-owner",
      pid: 424_243,
      acquiredAt: 1,
      heartbeatAt: 1,
    });
    let validated = 0;
    const runner = createFilesystemCredentialLeaseRunner(lockDir, {
      clock: () => 100_000,
      processStatus: () => "dead",
      onRecoveryReadyToRemove: async () => {
        validated += 1;
      },
    });

    await runner("credentials", async () => undefined);

    expect(validated).toBe(1);
  });

  it("never lets a delayed stale recoverer remove a newly acquired owner", async () => {
    const lockDir = await tempLockDir();
    await writeLock(lockDir, {
      formatVersion: 1,
      ownerToken: "stale-owner",
      pid: 424_244,
      acquiredAt: 1,
      heartbeatAt: 1,
    });
    const recoveryValidated = deferred();
    const resumeRecovery = deferred();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const delayedContended = deferred();
    let delayedContentions = 0;
    let inside = 0;
    let maximumInside = 0;
    const enter = (): void => {
      inside += 1;
      maximumInside = Math.max(maximumInside, inside);
    };
    const leave = (): void => {
      inside -= 1;
    };
    const delayed = createFilesystemCredentialLeaseRunner(lockDir, {
      clock: () => 100_000,
      processStatus: () => "dead",
      retryMs: 5,
      onRecoveryReadyToRemove: async () => {
        recoveryValidated.resolve();
        await resumeRecovery.promise;
      },
      onContention: async () => {
        delayedContentions += 1;
        if (delayedContentions === 2) delayedContended.resolve();
      },
    });
    const first = createFilesystemCredentialLeaseRunner(lockDir, {
      clock: () => 100_000,
      processStatus: () => "dead",
      retryMs: 5,
    });

    const delayedRun = delayed("credentials", async () => {
      enter();
      leave();
    });
    await recoveryValidated.promise;
    const firstRun = first("credentials", async () => {
      enter();
      firstEntered.resolve();
      await releaseFirst.promise;
      leave();
    });
    const firstOutcome = firstRun.catch((error: unknown) => error);
    await firstEntered.promise;
    resumeRecovery.resolve();
    await delayedContended.promise;
    expect(maximumInside).toBe(1);
    releaseFirst.resolve();
    await Promise.all([delayedRun, firstOutcome]);

    expect(maximumInside).toBe(1);
  });

  it("restores a newer owner moved by a late recoverer and fails closed", async () => {
    const lockDir = await tempLockDir();
    await writeLock(lockDir, {
      formatVersion: 1,
      ownerToken: "stale-owner",
      pid: 424_245,
      acquiredAt: 1,
      heartbeatAt: 1,
    });
    const staleObserved = deferred();
    const resumeLateRecovery = deferred();
    const firstEntered = deferred<LeaseRecord>();
    const releaseFirst = deferred();
    const lateContendedOnFirst = deferred();
    let lateContentions = 0;
    let inside = 0;
    let maximumInside = 0;
    const late = createFilesystemCredentialLeaseRunner(lockDir, {
      clock: () => 100_000,
      processStatus: () => "dead",
      retryMs: 5,
      onRecoveryObserved: async () => {
        staleObserved.resolve();
        await resumeLateRecovery.promise;
      },
      onContention: async () => {
        lateContentions += 1;
        if (lateContentions === 2) lateContendedOnFirst.resolve();
      },
    });
    const first = createFilesystemCredentialLeaseRunner(lockDir, {
      clock: () => 100_000,
      processStatus: () => "dead",
      retryMs: 5,
    });

    const lateRun = late("credentials", async () => {
      inside += 1;
      maximumInside = Math.max(maximumInside, inside);
      inside -= 1;
    });
    await staleObserved.promise;
    const firstRun = first("credentials", async () => {
      inside += 1;
      maximumInside = Math.max(maximumInside, inside);
      firstEntered.resolve(await readLock(lockDir));
      await releaseFirst.promise;
      inside -= 1;
    });
    await firstEntered.promise;
    resumeLateRecovery.resolve();
    await lateContendedOnFirst.promise;

    expect((await readLock(lockDir)).ownerToken).toBe(
      (await firstEntered.promise).ownerToken,
    );
    expect(maximumInside).toBe(1);
    releaseFirst.resolve();
    await Promise.all([firstRun, lateRun]);
    expect(maximumInside).toBe(1);
  });

  it("never publishes a partial lock when acquisition is interrupted before publication", async () => {
    const lockDir = await tempLockDir();
    const interrupted = createFilesystemCredentialLeaseRunner(lockDir, {
      beforePublish: async () => {
        throw new Error("publish-interrupted-CANARY");
      },
    });

    await expect(
      interrupted("credentials", async () => "must-not-enter"),
    ).rejects.toThrow("credential lease unavailable");
    await expect(stat(lockPath(lockDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(lockDir)).resolves.toEqual([]);
    await expect(
      createFilesystemCredentialLeaseRunner(lockDir)(
        "credentials",
        async () => "available",
      ),
    ).resolves.toBe("available");
  });

  it.each(["alive", "indeterminate"] as const)(
    "never steals a stale lease when its owner PID is %s",
    async (ownerStatus) => {
      const lockDir = await tempLockDir();
      const original: LeaseRecord = {
        formatVersion: 1,
        ownerToken: `owner-${ownerStatus}`,
        pid: 31337,
        acquiredAt: 1,
        heartbeatAt: 1,
      };
      await writeLock(lockDir, original);
      const runner = createFilesystemCredentialLeaseRunner(
        lockDir,
        deterministicTimeoutOptions(() => ownerStatus),
      );
      let entered = false;

      await expect(
        runner("credentials", async () => {
          entered = true;
        }),
      ).rejects.toThrow("credential lease unavailable");

      expect(entered).toBe(false);
      expect(await readLock(lockDir)).toEqual(original);
    },
  );

  it("uses a ten-second default heartbeat and advances the persisted heartbeat", async () => {
    const lockDir = await tempLockDir();
    const scheduledDelays: number[] = [];
    const cancelled: unknown[] = [];
    const scheduledCallbacks: Array<() => void> = [];
    let now = 10_000;
    const heartbeatRunner = createFilesystemCredentialLeaseRunner(lockDir, {
      clock: () => now,
      scheduleHeartbeat(callback, delayMs) {
        scheduledDelays.push(delayMs);
        scheduledCallbacks.push(callback);
        return callback;
      },
      cancelHeartbeat(timer) {
        cancelled.push(timer);
        const index = scheduledCallbacks.indexOf(timer as () => void);
        if (index >= 0) scheduledCallbacks.splice(index, 1);
      },
    });
    await heartbeatRunner("credentials", async () => {
      const initial = await readLock(lockDir);
      now += 10_000;
      scheduledCallbacks.shift()?.();
      await waitFor(() => scheduledCallbacks.length === 1);
      expect((await readLock(lockDir)).heartbeatAt).toBeGreaterThan(
        initial.heartbeatAt,
      );
    });

    expect(scheduledDelays.every((delayMs) => delayMs === 10_000)).toBe(true);
    expect(scheduledDelays.length).toBeGreaterThanOrEqual(1);
    expect(cancelled.length).toBeLessThanOrEqual(scheduledDelays.length);
    expect(scheduledCallbacks).toEqual([]);
  });

  it("releases its owned lock even when heartbeat persistence fails", async () => {
    const lockDir = await tempLockDir();
    const scheduledCallbacks: Array<() => void> = [];
    let heartbeatBlocker: string | undefined;
    const runner = createFilesystemCredentialLeaseRunner(lockDir, {
      scheduleHeartbeat(callback) {
        scheduledCallbacks.push(callback);
        return callback;
      },
      cancelHeartbeat(timer) {
        const index = scheduledCallbacks.indexOf(timer as () => void);
        if (index >= 0) scheduledCallbacks.splice(index, 1);
      },
    });

    await expect(
      runner("credentials", async () => {
        const { ownerToken } = await readLock(lockDir);
        heartbeatBlocker = path.join(
          lockDir,
          `.credentials.${ownerToken}.heartbeat`,
        );
        await writeFile(heartbeatBlocker, "blocked\n", {
          flag: "wx",
          mode: 0o600,
        });
        scheduledCallbacks.shift()?.();
      }),
    ).rejects.toThrow("credential lease ownership lost");

    if (heartbeatBlocker !== undefined) {
      await unlink(heartbeatBlocker).catch(() => undefined);
    }
    await expect(stat(lockPath(lockDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      createFilesystemCredentialLeaseRunner(lockDir)(
        "credentials",
        async () => "available",
      ),
    ).resolves.toBe("available");
  });

  it("times out or cancels waiters without leaking abort listeners or lock artifacts", async () => {
    const lockDir = await tempLockDir();
    const holder = createFilesystemCredentialLeaseRunner(lockDir, {
      retryMs: 5,
    });
    const waiter = createFilesystemCredentialLeaseRunner(lockDir, {
      retryMs: 5,
      waitTimeoutMs: 40,
    });
    let releaseHolder!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holding = holder("credentials", async () => gate);
    await waitFor(async () => {
      try {
        await stat(lockPath(lockDir));
        return true;
      } catch {
        return false;
      }
    });

    await expect(
      waiter("credentials", async () => "must-not-enter"),
    ).rejects.toThrow("credential lease unavailable");

    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const cancelled = waiter(
      "credentials",
      async () => "must-not-enter",
      { signal: controller.signal },
    );
    await waitFor(() => add.mock.calls.length > 0);
    controller.abort(new Error("cancel-CANARY"));
    await expect(cancelled).rejects.toThrow("credential lease unavailable");
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);

    releaseHolder();
    await holding;
    await expect(
      waiter("credentials", async () => "available"),
    ).resolves.toBe("available");
  });

  it("releases after callback failure while preserving the callback error", async () => {
    const lockDir = await tempLockDir();
    const runner = createFilesystemCredentialLeaseRunner(lockDir);

    await expect(
      runner("credentials", async () => {
        throw new Error("callback-CANARY");
      }),
    ).rejects.toThrow("callback-CANARY");

    await expect(
      runner("credentials", async () => "available"),
    ).resolves.toBe("available");
  });

  it("detects owner-token replacement at assert and release without deleting the replacement", async () => {
    const lockDir = await tempLockDir();
    const replacement: LeaseRecord = {
      formatVersion: 1,
      ownerToken: "replacement-owner",
      pid: process.pid,
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    const runner = createFilesystemCredentialLeaseRunner(lockDir, {
      heartbeatMs: 60_000,
    });

    await expect(
      runner("credentials", async (lease) => {
        await writeFile(
          lockPath(lockDir),
          `${JSON.stringify(replacement)}\n`,
          "utf8",
        );
        await lease.assertOwned();
      }),
    ).rejects.toThrow("credential lease ownership lost");
    expect(await readLock(lockDir)).toEqual(replacement);

    await unlink(lockPath(lockDir));
    await expect(
      runner("credentials", async () => {
        await writeFile(
          lockPath(lockDir),
          `${JSON.stringify(replacement)}\n`,
          "utf8",
        );
      }),
    ).rejects.toThrow("credential lease ownership lost");
    expect(await readLock(lockDir)).toEqual(replacement);
  });
});
