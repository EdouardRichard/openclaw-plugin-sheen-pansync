import { execFile, fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialStore } from "../../src/credentials/store.js";
import type { CredentialLeaseRunner } from "../../src/credentials/store.js";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { createTempState } from "../helpers/temp-state.js";

type ChildMessage = {
  type: "started" | "refreshing" | "result" | "error";
  pid: number;
  value?: string;
  code?: string;
};

type ChildClose = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const execFileAsync = promisify(execFile);
const children = new Set<ChildProcess>();
let buildCleanup: (() => Promise<void>) | undefined;
let compiledDirectory: string;
let node22Executable: string;
const immediateLease: CredentialLeaseRunner = (_key, run) => run({
  assertOwned: async () => undefined,
});

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
  compiledDirectory = path.join(state.dataDir, "compiled");
  await execFileAsync(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
      "-p",
      path.join(process.cwd(), "tsconfig.build.json"),
      "--outDir",
      compiledDirectory,
      "--declaration",
      "false",
      "--sourceMap",
      "false",
    ],
    { cwd: process.cwd(), timeout: 30_000, windowsHide: true },
  );
  node22Executable = await resolveNode22Executable();
}, 60_000);

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  children.clear();
  await buildCleanup?.();
});

function credentialRecord(refreshApiUrl: string): CredentialRecord {
  return {
    formatVersion: 2,
    credentialVersion: 1,
    authorizationPageUrl: "http://auth.example.test/custom",
    refreshApiUrl,
    refreshToken: "refresh-stale",
    accessToken: "access-stale",
    account: { userIdMasked: "use***89" },
    lastVerifiedAt: "2026-08-01T12:00:00.000Z",
    refreshState: { status: "ready" },
  };
}

function moduleUrl(...segments: string[]): string {
  return pathToFileURL(path.join(compiledDirectory, ...segments)).href;
}

function startChild(dataDir: string, databasePath: string): {
  child: ChildProcess;
  closed: Promise<ChildClose>;
  messages: ChildMessage[];
  stderr: string[];
} {
  const child = fork(
    path.join(process.cwd(), "tests", "helpers", "token-refresh-child.mjs"),
    [],
    {
      execPath: node22Executable,
      env: {
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          "--disable-warning=ExperimentalWarning",
        ].filter((value) => value !== undefined && value.length > 0).join(" "),
        PAN_SYNC_DATA_DIR: dataDir,
        PAN_SYNC_LEASE_DATABASE: databasePath,
        PAN_SYNC_STORE_MODULE_URL: moduleUrl("credentials", "store.js"),
        PAN_SYNC_LEASE_MODULE_URL: moduleUrl(
          "credentials",
          "sqlite-worker-lease.js",
        ),
        PAN_SYNC_TOKEN_SERVICE_MODULE_URL: moduleUrl(
          "providers",
          "aliyun",
          "openlist-token-service.js",
        ),
        PAN_SYNC_TOKEN_MANAGER_MODULE_URL: moduleUrl(
          "credentials",
          "token-manager.js",
        ),
      },
      silent: true,
    },
  );
  children.add(child);
  const closed = new Promise<ChildClose>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const messages: ChildMessage[] = [];
  const stderr: string[] = [];
  child.on("message", (message) => messages.push(message as ChildMessage));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
  return { child, closed, messages, stderr };
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForType(
  messages: ChildMessage[],
  type: ChildMessage["type"],
): Promise<ChildMessage> {
  await waitForCondition(() => messages.some((message) => message.type === type));
  return messages.find((message) => message.type === type)!;
}

async function withOpenList(
  responseStatus: 200 | 429,
  run: (server: {
    refreshApiUrl: string;
    requests: string[];
    release(): void;
  }) => Promise<void>,
): Promise<void> {
  let releaseResponse: (() => void) | undefined;
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url ?? "");
    await responseReleased;
    if (responseStatus === 429) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      access_token: "access-rotated",
      refresh_token: "refresh-rotated",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run({
      refreshApiUrl: `http://127.0.0.1:${address.port}/refresh`,
      requests,
      release: () => releaseResponse?.(),
    });
  } finally {
    releaseResponse?.();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }));
  }
}

async function runTwoChildren(
  dataDir: string,
  databasePath: string,
  releaseResponse: () => void,
): Promise<ChildMessage[]> {
  const first = startChild(dataDir, databasePath);
  const second = startChild(dataDir, databasePath);
  await Promise.all([
    waitForType(first.messages, "started"),
    waitForType(second.messages, "started"),
  ]);
  first.child.send?.({ type: "go" });
  second.child.send?.({ type: "go" });
  await Promise.all([
    waitForType(first.messages, "refreshing"),
    waitForType(second.messages, "refreshing"),
  ]);
  releaseResponse();
  const [firstClose, secondClose] = await Promise.all([
    first.closed,
    second.closed,
  ]);
  children.delete(first.child);
  children.delete(second.child);
  expect(firstClose).toEqual({ code: 0, signal: null });
  expect(secondClose).toEqual({ code: 0, signal: null });
  expect([...first.stderr, ...second.stderr].join(""), "child stderr").toBe("");
  return [
    first.messages.find(({ type }) => type === "result" || type === "error")!,
    second.messages.find(({ type }) => type === "result" || type === "error")!,
  ];
}

describe("TokenManager refresh lease built artifact", () => {
  it("serializes two processes and shares the rotated token", async () => {
    const state = await createTempState();
    try {
      const databasePath = path.join(state.dataDir, "locks", "lease.sqlite");
      const store = new CredentialStore(
        state.dataDir,
        immediateLease,
      );
      await withOpenList(200, async (openList) => {
        await store.replace(credentialRecord(openList.refreshApiUrl));

        const results = await runTwoChildren(
          state.dataDir,
          databasePath,
          openList.release,
        );

        expect(openList.requests).toHaveLength(1);
        expect(results.map(({ value }) => value)).toEqual([
          "access-rotated",
          "access-rotated",
        ]);
        expect((await store.read())?.refreshToken).toBe("refresh-rotated");
      });
    } finally {
      await state.cleanup();
    }
  }, 30_000);

  it("shares a persisted 429 cooldown without a second upstream request", async () => {
    const state = await createTempState();
    try {
      const databasePath = path.join(state.dataDir, "locks", "lease.sqlite");
      const store = new CredentialStore(
        state.dataDir,
        immediateLease,
      );
      await withOpenList(429, async (openList) => {
        await store.replace(credentialRecord(openList.refreshApiUrl));

        const results = await runTwoChildren(
          state.dataDir,
          databasePath,
          openList.release,
        );

        expect(openList.requests).toHaveLength(1);
        expect(results.map(({ code }) => code)).toEqual([
          "RATE_LIMITED",
          "RATE_LIMITED",
        ]);
        await expect(store.read()).resolves.toMatchObject({
          credentialVersion: 2,
          refreshToken: "refresh-stale",
          accessToken: "access-stale",
          refreshState: {
            status: "rate_limited",
            failureCode: "RATE_LIMITED",
          },
        });
      });
    } finally {
      await state.cleanup();
    }
  }, 30_000);
});
