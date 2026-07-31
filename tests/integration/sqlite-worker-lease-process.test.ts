import { execFile, fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempState, octalMode } from "../helpers/temp-state.js";

type ChildMessage = {
  type:
    | "started"
    | "tick"
    | "entered"
    | "entered-first"
    | "entered-second"
    | "ownership-aborted"
    | "done"
    | "rejected";
  pid: number;
  message?: string;
};

const execFileAsync = promisify(execFile);
const children = new Set<ChildProcess>();
let buildCleanup: (() => Promise<void>) | undefined;
let moduleUrl: string;
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
  moduleUrl = pathToFileURL(
    path.join(compileDir, "credentials", "sqlite-worker-lease.js"),
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

async function waitForMessage(
  messages: ChildMessage[],
  type: ChildMessage["type"],
  timeoutMs = 8_000,
): Promise<ChildMessage> {
  await waitForCondition(() => messages.some((message) => message.type === type), timeoutMs);
  return messages.find((message) => message.type === type)!;
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<void> {
  await waitForCondition(
    () => child.exitCode !== null || child.signalCode !== null,
    timeoutMs,
  );
  children.delete(child);
}

function startChild(
  databasePath: string,
  mode: "normal" | "abortable" | "dual" = "normal",
): { child: ChildProcess; messages: ChildMessage[] } {
  const child = fork(
    path.join(process.cwd(), "tests", "helpers", "sqlite-worker-lease-child.mjs"),
    [],
    {
      execPath: node22Executable,
      env: {
        ...process.env,
        PAN_SYNC_LEASE_MODULE_URL: moduleUrl,
        PAN_SYNC_LEASE_DATABASE: databasePath,
        PAN_SYNC_LEASE_MODE: mode,
      },
      silent: true,
    },
  );
  children.add(child);
  return { child, messages: messagesFor(child) };
}

async function tempDatabasePath(): Promise<{
  databasePath: string;
  cleanup: () => Promise<void>;
}> {
  const state = await createTempState();
  return {
    databasePath: path.join(state.dataDir, "locks", "lease.sqlite"),
    cleanup: state.cleanup,
  };
}

describe("SQLite Worker credential lease built artifact", () => {
  it("serializes two processes while the waiting process event loop remains responsive", async () => {
    const state = await tempDatabasePath();
    const holder = startChild(state.databasePath);
    await waitForMessage(holder.messages, "entered");
    const contender = startChild(state.databasePath);
    await waitForMessage(contender.messages, "started");
    await waitForMessage(contender.messages, "tick");

    expect(contender.messages.some(({ type }) => type === "entered")).toBe(false);
    if (process.platform !== "win32") {
      expect(await octalMode(path.dirname(state.databasePath))).toBe("700");
      expect(await octalMode(state.databasePath)).toBe("600");
    }
    holder.child.send?.({ type: "release" });
    await waitForMessage(holder.messages, "done");
    await waitForExit(holder.child);
    await waitForMessage(contender.messages, "entered");
    contender.child.send?.({ type: "release" });
    await waitForMessage(contender.messages, "done");
    await waitForExit(contender.child);

    expect((await readdir(path.dirname(state.databasePath))).sort()).toEqual([
      "lease.sqlite",
    ]);
    await state.cleanup();
  }, 30_000);

  it("cancels an acquiring Worker promptly without disturbing the holder", async () => {
    const state = await tempDatabasePath();
    const holder = startChild(state.databasePath);
    await waitForMessage(holder.messages, "entered");
    const cancelled = startChild(state.databasePath);
    await waitForMessage(cancelled.messages, "tick");
    cancelled.child.send?.({ type: "cancel" });

    const rejection = await waitForMessage(cancelled.messages, "rejected", 2_000);
    expect(rejection.message).toBe("credential lease unavailable");
    await waitForExit(cancelled.child, 2_000);
    expect(holder.messages.some(({ type }) => type === "done")).toBe(false);
    holder.child.send?.({ type: "release" });
    await waitForMessage(holder.messages, "done");
    await waitForExit(holder.child);
    await state.cleanup();
  }, 30_000);

  it("serializes independent Workers owned by callers in the same process", async () => {
    const state = await tempDatabasePath();
    const processWithTwoCallers = startChild(state.databasePath, "dual");
    await waitForMessage(processWithTwoCallers.messages, "entered-first");
    await waitForMessage(processWithTwoCallers.messages, "tick");
    expect(
      processWithTwoCallers.messages.some(({ type }) => type === "entered-second"),
    ).toBe(false);

    processWithTwoCallers.child.send?.({ type: "release-first" });
    await waitForMessage(processWithTwoCallers.messages, "entered-second");
    processWithTwoCallers.child.send?.({ type: "release-second" });
    await waitForMessage(processWithTwoCallers.messages, "done");
    await waitForExit(processWithTwoCallers.child);
    await state.cleanup();
  }, 30_000);

  it("keeps an aborted callback transaction until unwind before handing off", async () => {
    const state = await tempDatabasePath();
    const holder = startChild(state.databasePath, "abortable");
    await waitForMessage(holder.messages, "entered");
    holder.child.send?.({ type: "cancel" });
    await waitForMessage(holder.messages, "ownership-aborted");
    const contender = startChild(state.databasePath);
    await waitForMessage(contender.messages, "tick");
    expect(contender.messages.some(({ type }) => type === "entered")).toBe(false);

    holder.child.send?.({ type: "unwind" });
    const rejection = await waitForMessage(holder.messages, "rejected");
    expect(rejection.message).toBe("credential lease unavailable");
    await waitForExit(holder.child);
    await waitForMessage(contender.messages, "entered");
    contender.child.send?.({ type: "release" });
    await waitForMessage(contender.messages, "done");
    await waitForExit(contender.child);
    await state.cleanup();
  }, 30_000);

  it("automatically releases the transaction when the holder process dies", async () => {
    const state = await tempDatabasePath();
    const doomed = startChild(state.databasePath);
    const doomedEntry = await waitForMessage(doomed.messages, "entered");
    doomed.child.kill();
    await waitForExit(doomed.child);
    const successor = startChild(state.databasePath);
    const successorEntry = await waitForMessage(successor.messages, "entered");

    expect(successorEntry.pid).not.toBe(doomedEntry.pid);
    successor.child.send?.({ type: "release" });
    await waitForMessage(successor.messages, "done");
    await waitForExit(successor.child);
    expect((await stat(state.databasePath)).isFile()).toBe(true);
    expect((await readdir(path.dirname(state.databasePath))).sort()).toEqual([
      "lease.sqlite",
    ]);
    await state.cleanup();
  }, 30_000);
});
