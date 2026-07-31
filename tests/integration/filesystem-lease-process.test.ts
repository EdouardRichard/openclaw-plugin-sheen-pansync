import { execFile, fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTempState } from "../helpers/temp-state.js";

type ChildMessage = {
  type: "contention" | "entered" | "done" | "error";
  pid: number;
  message?: string;
};

const execFileAsync = promisify(execFile);
const children = new Set<ChildProcess>();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  children.clear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function waitForMessage(
  child: ChildProcess,
  type: ChildMessage["type"],
  timeoutMs = 8_000,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error(`child message timeout: ${type}`));
    }, timeoutMs);
    const onMessage = (candidate: unknown): void => {
      const message = candidate as Partial<ChildMessage>;
      if (message.type === "error") {
        finish(new Error(`child failed: ${message.message ?? "unknown"}`));
      } else if (message.type === type && typeof message.pid === "number") {
        finish(undefined, message as ChildMessage);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`child exited before ${type}: ${code ?? signal}`));
    };
    const finish = (error?: Error, message?: ChildMessage): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve(message as ChildMessage);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("child exit timeout")), timeoutMs);
    const onExit = (): void => finish();
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    child.on("exit", onExit);
  });
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("filesystem condition timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("FilesystemCredentialLeaseRunner child-process integration", () => {
  it("serializes contenders and recovers only after a dead owner's heartbeat is stale", async () => {
    const state = await createTempState();
    cleanups.push(state.cleanup);
    const compileDir = path.join(state.dataDir, "compiled");
    await execFileAsync(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
        "-p",
        path.join(process.cwd(), "tsconfig.build.json"),
        "--outDir",
        compileDir,
        "--declaration",
        "false",
        "--sourceMap",
        "false",
      ],
      { cwd: process.cwd(), windowsHide: true },
    );

    const lockDir = path.join(state.dataDir, "locks");
    const lockPath = path.join(lockDir, "credentials.lock");
    const childScript = path.join(
      process.cwd(),
      "tests",
      "helpers",
      "filesystem-lease-child.mjs",
    );
    const moduleUrl = pathToFileURL(
      path.join(compileDir, "credentials", "filesystem-lease.js"),
    ).href;
    const heartbeatMs = 40;
    const staleMs = 180;
    const forkChild = (): ChildProcess => {
      const child = fork(childScript, [], {
        execPath: process.execPath,
        env: {
          ...process.env,
          PAN_SYNC_LEASE_MODULE_URL: moduleUrl,
          PAN_SYNC_LOCK_DIR: lockDir,
          PAN_SYNC_HEARTBEAT_MS: String(heartbeatMs),
          PAN_SYNC_STALE_MS: String(staleMs),
          PAN_SYNC_RETRY_MS: "10",
          PAN_SYNC_WAIT_TIMEOUT_MS: "8000",
        },
        silent: true,
      });
      children.add(child);
      return child;
    };
    const readLock = async (): Promise<{
      pid: number;
      acquiredAt: number;
      heartbeatAt: number;
    }> => JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      acquiredAt: number;
      heartbeatAt: number;
    };

    const first = forkChild();
    const firstEntered = await waitForMessage(first, "entered");
    const second = forkChild();
    const secondContended = waitForMessage(second, "contention");
    const secondEntry = waitForMessage(second, "entered");
    await secondContended;
    expect((await readLock()).pid).toBe(firstEntered.pid);

    const firstDone = waitForMessage(first, "done");
    first.send?.({ type: "release" });
    await firstDone;
    await waitForExit(first);
    const secondEntered = await secondEntry;
    expect(secondEntered.pid).not.toBe(firstEntered.pid);
    expect((await readLock()).pid).toBe(secondEntered.pid);
    const secondDone = waitForMessage(second, "done");
    second.send?.({ type: "release" });
    await secondDone;
    await waitForExit(second);

    const doomed = forkChild();
    const doomedEntered = await waitForMessage(doomed, "entered");
    await waitForCondition(async () => {
      const record = await readLock();
      return record.pid === doomedEntered.pid
        && record.heartbeatAt > record.acquiredAt;
    });
    doomed.kill();
    await waitForExit(doomed);
    await waitForCondition(async () => {
      const record = await readLock();
      return record.pid === doomedEntered.pid
        && Date.now() - record.heartbeatAt >= staleMs;
    });

    const recovery = forkChild();
    const recoveryContended = waitForMessage(recovery, "contention");
    const recoveryEntry = waitForMessage(recovery, "entered");
    await recoveryContended;
    const recoveredEntered = await recoveryEntry;
    expect(recoveredEntered.pid).not.toBe(doomedEntered.pid);
    expect((await readLock()).pid).toBe(recoveredEntered.pid);
    const recoveryDone = waitForMessage(recovery, "done");
    recovery.send?.({ type: "release" });
    await recoveryDone;
    await waitForExit(recovery);
  }, 30_000);
});
