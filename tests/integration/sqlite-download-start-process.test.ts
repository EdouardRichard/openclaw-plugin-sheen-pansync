import { execFile, fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempState } from "../helpers/temp-state.js";

type ChildMessage =
  | { type: "started" }
  | { type: "acquiring" }
  | { type: "granted"; grantedAt: number }
  | { type: "cancelled" }
  | { type: "failed" };

type DatabaseSnapshot = { count: number; startedAtMs: number[] };

const WINDOW_MS = 5_000;
const GUARD_MS = 25;
const LIMIT = 2;
const BOUNDARY_MS = WINDOW_MS + GUARD_MS;
const execFileAsync = promisify(execFile);
const children = new Set<ChildProcess>();
let buildCleanup: (() => Promise<void>) | undefined;
let storeModuleUrl: string;
let limiterModuleUrl: string;
let node22Executable: string;

function nodeSupportsSqlite(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 22);
}

async function resolveNode22Executable(): Promise<string> {
  if (nodeSupportsSqlite()) return process.execPath;
  const { stdout } = await execFileAsync(
    "volta",
    ["run", "--node", "22.23.1", "node", "-p", "process.execPath"],
    { cwd: process.cwd(), timeout: 45_000, windowsHide: true },
  );
  return stdout.trim();
}

beforeAll(async () => {
  const state = await createTempState();
  buildCleanup = state.cleanup;
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
    { cwd: process.cwd(), timeout: 30_000, windowsHide: true },
  );
  storeModuleUrl = pathToFileURL(
    path.join(compileDir, "providers", "aliyun", "sqlite-download-start-store.js"),
  ).href;
  limiterModuleUrl = pathToFileURL(
    path.join(compileDir, "providers", "aliyun", "download-start-limiter.js"),
  ).href;
  node22Executable = await resolveNode22Executable();
}, 60_000);

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  children.clear();
  await buildCleanup?.();
});

function messagesFor(child: ChildProcess): ChildMessage[] {
  const messages: ChildMessage[] = [];
  child.on("message", (message) => messages.push(message as ChildMessage));
  return messages;
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForMessage<T extends ChildMessage["type"]>(
  messages: ChildMessage[],
  type: T,
  timeoutMs = 8_000,
): Promise<Extract<ChildMessage, { type: T }>> {
  await waitForCondition(() => messages.some((message) => message.type === type), timeoutMs);
  return messages.find((message) => message.type === type)! as Extract<
    ChildMessage,
    { type: T }
  >;
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<void> {
  await waitForCondition(
    () => child.exitCode !== null || child.signalCode !== null,
    timeoutMs,
  );
  children.delete(child);
}

function startChild(databasePath: string): {
  child: ChildProcess;
  messages: ChildMessage[];
} {
  const child = fork(
    path.join(process.cwd(), "tests", "helpers", "sqlite-download-start-child.mjs"),
    [],
    {
      execPath: node22Executable,
      env: {
        ...process.env,
        PAN_SYNC_DOWNLOAD_START_STORE_MODULE_URL: storeModuleUrl,
        PAN_SYNC_DOWNLOAD_START_LIMITER_MODULE_URL: limiterModuleUrl,
        PAN_SYNC_DOWNLOAD_START_DATABASE: databasePath,
        PAN_SYNC_DOWNLOAD_START_LIMIT: String(LIMIT),
        PAN_SYNC_DOWNLOAD_START_WINDOW_MS: String(WINDOW_MS),
        PAN_SYNC_DOWNLOAD_START_GUARD_MS: String(GUARD_MS),
      },
      silent: true,
    },
  );
  children.add(child);
  return { child, messages: messagesFor(child) };
}

async function inspect(databasePath: string): Promise<DatabaseSnapshot> {
  const { stdout } = await execFileAsync(
    node22Executable,
    [path.join(process.cwd(), "tests", "helpers", "sqlite-download-start-inspect.mjs")],
    {
      cwd: process.cwd(),
      env: { ...process.env, PAN_SYNC_DOWNLOAD_START_DATABASE: databasePath },
      timeout: 8_000,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as DatabaseSnapshot;
}

async function createDatabaseState(): Promise<{
  databasePath: string;
  locksDirectory: string;
  cleanup: () => Promise<void>;
}> {
  const state = await createTempState();
  const locksDirectory = path.join(state.dataDir, "locks");
  return {
    databasePath: path.join(locksDirectory, "download-rate-limit.sqlite"),
    locksDirectory,
    cleanup: state.cleanup,
  };
}

async function startAndExit(
  databasePath: string,
  count: number,
): Promise<Array<Extract<ChildMessage, { type: "granted" }>>> {
  const started = Array.from({ length: count }, () => startChild(databasePath));
  await Promise.all(started.map(({ messages }) => waitForMessage(messages, "started")));
  await Promise.all(started.map(({ messages }) => waitForMessage(messages, "acquiring")));
  const grants = await Promise.all(started.map(({ messages }) => waitForMessage(messages, "granted")));
  await Promise.all(started.map(({ child }) => waitForExit(child)));
  return grants;
}

describe("SQLite download-start limiter built artifact", () => {
  it("persists a full window across exited processes and automatically grants the third after it expires", async () => {
    const state = await createDatabaseState();
    try {
      const initialGrants = await startAndExit(state.databasePath, LIMIT);
      expect(Math.max(...initialGrants.map(({ grantedAt }) => grantedAt))).toBeLessThan(
        Math.min(...initialGrants.map(({ grantedAt }) => grantedAt)) + WINDOW_MS,
      );

      const persisted = await inspect(state.databasePath);
      expect(persisted.count).toBe(LIMIT);
      expect(persisted.startedAtMs).toEqual([...persisted.startedAtMs].sort((a, b) => a - b));
      const boundary = persisted.startedAtMs[0]! + BOUNDARY_MS;

      const third = startChild(state.databasePath);
      await waitForMessage(third.messages, "started");
      await waitForMessage(third.messages, "acquiring");

      const thirdGrant = await waitForMessage(third.messages, "granted");
      expect(thirdGrant.grantedAt).toBeGreaterThanOrEqual(boundary);
      await waitForExit(third.child);
      expect(await inspect(state.databasePath)).toMatchObject({ count: 1 });
      expect((await readdir(state.locksDirectory)).sort()).toEqual([
        "download-rate-limit.sqlite",
      ]);
    } finally {
      await state.cleanup();
    }
  }, 30_000);

  it("allows only one racing process into the last slot before the boundary", async () => {
    const state = await createDatabaseState();
    try {
      await startAndExit(state.databasePath, LIMIT - 1);
      const beforeRace = await inspect(state.databasePath);
      const boundary = beforeRace.startedAtMs[0]! + BOUNDARY_MS;
      const first = startChild(state.databasePath);
      const second = startChild(state.databasePath);
      await Promise.all([
        waitForMessage(first.messages, "started"),
        waitForMessage(second.messages, "started"),
      ]);
      await Promise.all([
        waitForMessage(first.messages, "acquiring"),
        waitForMessage(second.messages, "acquiring"),
      ]);
      await waitForCondition(
        () => [...first.messages, ...second.messages].filter(({ type }) => type === "granted").length === 1,
      );
      const racingGrants = [...first.messages, ...second.messages].filter(
        (message): message is Extract<ChildMessage, { type: "granted" }> =>
          message.type === "granted",
      );
      expect(racingGrants).toHaveLength(1);
      expect(racingGrants[0]!.grantedAt).toBeLessThan(boundary);

      const waiting = first.messages.some(({ type }) => type === "granted") ? second : first;
      waiting.child.send?.({ type: "cancel" });
      await waitForMessage(waiting.messages, "cancelled");
      await waitForExit(waiting.child);
      const granted = waiting === first ? second : first;
      await waitForExit(granted.child);
      expect(await inspect(state.databasePath)).toMatchObject({ count: LIMIT });
      expect((await readdir(state.locksDirectory)).sort()).toEqual([
        "download-rate-limit.sqlite",
      ]);
    } finally {
      await state.cleanup();
    }
  }, 30_000);

  it("cancels a waiting process without inserting a row and leaves a later process eligible", async () => {
    const state = await createDatabaseState();
    try {
      await startAndExit(state.databasePath, LIMIT);
      const fullWindow = await inspect(state.databasePath);
      const boundary = fullWindow.startedAtMs[0]! + BOUNDARY_MS;
      const cancelled = startChild(state.databasePath);
      await waitForMessage(cancelled.messages, "started");
      await waitForMessage(cancelled.messages, "acquiring");
      cancelled.child.send?.({ type: "cancel" });
      await waitForMessage(cancelled.messages, "cancelled");
      await waitForExit(cancelled.child);
      expect(await inspect(state.databasePath)).toEqual(fullWindow);

      const successor = startChild(state.databasePath);
      await waitForMessage(successor.messages, "started");
      await waitForMessage(successor.messages, "acquiring");
      const successorGrant = await waitForMessage(successor.messages, "granted");
      expect(successorGrant.grantedAt).toBeGreaterThanOrEqual(boundary);
      await waitForExit(successor.child);
      expect((await readdir(state.locksDirectory)).sort()).toEqual([
        "download-rate-limit.sqlite",
      ]);
    } finally {
      await state.cleanup();
    }
  }, 30_000);
});
