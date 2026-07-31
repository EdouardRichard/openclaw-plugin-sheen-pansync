import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OpenClawPluginApi,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginService,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { startSetupServer, type SetupServer } from "../../src/admin/setup-server.js";
import { createPanSyncStatusRoute } from "../../src/admin/status-route.js";
import { TokenManager, type TokenCredentialVault } from "../../src/credentials/token-manager.js";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { createPanSyncPluginEntry } from "../../src/index.js";
import { ProviderRegistry } from "../../src/provider-registry.js";
import { AliyunHttpClient } from "../../src/providers/aliyun/http.js";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";
import { registerPanSyncUploadTool, type PanSyncUploadToolApi } from "../../src/tool.js";
import { UploadOrchestrator } from "../../src/upload/orchestrator.js";
import { startFakeAliyunServer, type FakeAliyunServer } from "../helpers/fake-aliyun-server.js";

const CLIENT_SECRET = "client-secret-CANARY-8b26";
const REFRESH_TOKEN = "refresh-token-CANARY-19d4";
const ACCESS_TOKEN = "access-token-CANARY-62a1";
const ABSOLUTE_PATH = "/srv/private/openclaw/workspace/report.pdf";
const NOW = Date.parse("2026-08-01T00:00:00.000Z");

const cleanups: Array<() => Promise<void>> = [];
const runningServers: SetupServer[] = [];
const aliyunServers: FakeAliyunServer[] = [];

function record(expiresAt = "2099-01-01T00:00:00.000Z"): CredentialRecord {
  return {
    formatVersion: 1,
    credentialVersion: 1,
    clientId: "client-id-123456",
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN,
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: expiresAt,
    account: { userIdMasked: "use***42", displayNameMasked: "R***" },
    lastVerifiedAt: "2026-08-01T00:00:00.000Z",
  };
}

function memoryVault(initial: CredentialRecord): TokenCredentialVault & {
  current(): CredentialRecord;
} {
  let saved = initial;
  return {
    current: () => saved,
    read: async () => saved,
    async replaceIfVersion(expected, candidate) {
      if (saved.credentialVersion !== expected) return false;
      saved = candidate;
      return true;
    },
  };
}

function toolFor(orchestrator: UploadOrchestrator, workspaceDir: string) {
  let factory: Parameters<PanSyncUploadToolApi["registerTool"]>[0] | undefined;
  registerPanSyncUploadTool({
    registerTool(candidate) {
      factory = candidate;
    },
  }, orchestrator);
  if (factory === undefined) throw new Error("tool registration missing");
  return factory({ workspaceDir });
}

function orchestratorFor(
  server: FakeAliyunServer,
  vault: TokenCredentialVault,
  defaultDirectory = "/",
) {
  const httpClient = new AliyunHttpClient({
    baseUrl: server.baseUrl,
    clock: () => NOW,
  });
  const tokenManager = new TokenManager(vault, httpClient, () => NOW);
  const provider = new AliyunProvider({
    httpClient,
    tokenManager,
    baseUrl: server.baseUrl,
    clock: () => NOW,
  });
  return {
    httpClient,
    provider,
    tokenManager,
    orchestrator: new UploadOrchestrator({
      providerRegistry: new ProviderRegistry([provider], "aliyun"),
      tokenManager,
      config: { defaultDirectory },
    }),
  };
}

async function invokeRoute(handler: OpenClawPluginHttpRouteHandler) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    return await (await fetch(`http://127.0.0.1:${address.port}/status`)).text();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

function setupAccessKey(url: string): string {
  return new URL(url).hash.slice(1);
}

async function setupRequest(
  server: SetupServer,
  pathname: string,
  init: RequestInit = {},
) {
  const baseUrl = server.url.split("/#")[0];
  if (baseUrl === undefined) throw new Error("setup URL missing");
  const headers = new Headers(init.headers);
  headers.set("authorization", `PanSyncSetup ${setupAccessKey(server.url)}`);
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

function containsProtectedValue(values: readonly unknown[]): boolean {
  const pending = [...values];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (
        value.includes(CLIENT_SECRET)
        || value.includes(REFRESH_TOKEN)
        || value.includes(ACCESS_TOKEN)
        || value.includes(ABSOLUTE_PATH)
      ) {
        return true;
      }
      continue;
    }
    if (typeof value === "symbol") {
      pending.push(value.description, Symbol.keyFor(value));
      continue;
    }
    if (
      (typeof value !== "object" || value === null)
      && typeof value !== "function"
    ) {
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);

    if (value instanceof Error) {
      pending.push(value.name, value.message, value.stack, value.cause);
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) pending.push(key, entry);
    }
    if (value instanceof Set) {
      for (const entry of value) pending.push(entry);
    }

    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      continue;
    }
    for (const key of keys) {
      pending.push(key);
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && "value" in descriptor) {
          pending.push(descriptor.value);
        }
      } catch {
        // Do not invoke or trust accessors while inspecting logger arguments.
      }
    }
  }
  return false;
}

function assertNoProtectedArguments(
  label: string,
  values: readonly unknown[],
): void {
  if (containsProtectedValue(values)) {
    throw new Error(`${label} exposed a protected value`);
  }
}

async function exercisePluginLoggerBoundary(
  stateDir: string,
  workspaceDir: string,
  logger: {
    debug(...values: unknown[]): unknown;
    info(...values: unknown[]): unknown;
    warn(...values: unknown[]): unknown;
    error(...values: unknown[]): unknown;
  },
): Promise<void> {
  let toolFactory: OpenClawPluginToolFactory | undefined;
  let service: OpenClawPluginService | undefined;
  const entry = createPanSyncPluginEntry({
    credentialLeaseFactory: () => async (_key, run) =>
      run({ assertOwned: async () => undefined }),
  });
  const api = {
    id: "pan-sync-helper",
    name: "Pan Sync Helper",
    source: "leakage-gate",
    registrationMode: "full",
    pluginConfig: {},
    logger,
    runtime: { state: { resolveStateDir: () => stateDir } },
    registerTool(candidate: OpenClawPluginToolFactory) {
      toolFactory = candidate;
    },
    registerCli() {},
    registerHttpRoute() {},
    registerService(candidate: OpenClawPluginService) {
      service = candidate;
    },
    session: {
      controls: { registerControlUiDescriptor() {} },
    },
  } as unknown as OpenClawPluginApi;
  if (entry.register === undefined) throw new Error("plugin register missing");
  entry.register(api);
  if (toolFactory === undefined || service === undefined) {
    throw new Error("plugin runtime registration missing");
  }

  const context = { config: {}, stateDir, logger } as never;
  await service.start(context);
  try {
    const tool = toolFactory({ workspaceDir } as never);
    if (tool === null || tool === undefined || Array.isArray(tool)) {
      throw new Error("plugin registered an invalid Tool boundary");
    }
    const result = await tool.execute("plugin-logger-boundary", {
      paths: ["report.txt"],
    });
    expect(result.details).toEqual({ code: "CREDENTIALS_REQUIRED" });
  } finally {
    await service.stop?.(context);
  }
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
  await Promise.all(aliyunServers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("release leakage canaries", () => {
  it.each([
    ["Error message", () => new Error(ACCESS_TOKEN)],
    ["Error stack", () => {
      const error = new Error("safe message");
      error.stack = REFRESH_TOKEN;
      return error;
    }],
    ["Error cause", () => {
      const error = new Error("safe message", { cause: CLIENT_SECRET });
      error.stack = "safe stack";
      return error;
    }],
    ["non-enumerable own property", () => {
      const value = {};
      Object.defineProperty(value, "hidden", {
        value: ABSOLUTE_PATH,
        enumerable: false,
      });
      return value;
    }],
    ["symbol property", () => {
      const value: Record<PropertyKey, unknown> = {};
      value[Symbol("protected logger property")] = CLIENT_SECRET;
      return value;
    }],
    ["symbol description", () => Symbol(REFRESH_TOKEN)],
    ["nested array and object", () => ({ nested: [{ value: ACCESS_TOKEN }] })],
    ["cycle", () => {
      const value: Record<string, unknown> = {
        nested: { value: ABSOLUTE_PATH },
      };
      value.self = value;
      return value;
    }],
  ] as const)("inspects protected values in %s", (_name, createValue) => {
    expect(() =>
      assertNoProtectedArguments("host logger arguments", [createValue()])
    ).toThrow("host logger arguments exposed a protected value");
  });

  it("handles clean cyclic logger arguments", () => {
    const value: Record<string, unknown> = { nested: ["safe"] };
    value.self = value;
    expect(() =>
      assertNoProtectedArguments("host logger arguments", [value])
    ).not.toThrow();
  });

  it("keeps credentials, access tokens, and workspace paths out of failure surfaces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pan-sync-leakage-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "report.txt"), "release gate\n");

    const invalidServer = await startFakeAliyunServer({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: `${CLIENT_SECRET} ${REFRESH_TOKEN}`,
      },
    });
    aliyunServers.push(invalidServer);
    const saved = record();
    const invalidRuntime = orchestratorFor(invalidServer, memoryVault(saved));
    const setup = await startSetupServer({
      store: {
        read: async () => saved,
        replaceIfVersion: async () => false,
        clear: async () => undefined,
      },
      provider: invalidRuntime.provider,
      orchestrator: invalidRuntime.orchestrator,
      dataDir: path.join(root, "setup-data"),
      assetsDir: path.resolve("ui"),
      clock: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 0x2a),
      defaultDirectory: "/openClawShare",
    });
    runningServers.push(setup);

    const invalidResponse = await setupRequest(setup, "/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: saved.clientId,
        clientSecret: saved.clientSecret,
        refreshToken: saved.refreshToken,
      }),
    });
    const invalidOutput = await invalidResponse.text();
    expect(invalidResponse.status).toBe(400);
    expect(JSON.parse(invalidOutput)).toEqual({ code: "CREDENTIALS_INVALID" });

    const configResponse = await setupRequest(setup, "/api/config");
    const configOutput = await configResponse.text();
    expect(configResponse.status).toBe(200);
    expect(configOutput.includes(CLIENT_SECRET)).toBe(true);
    expect(configOutput.includes(REFRESH_TOKEN)).toBe(true);
    if (configOutput.includes(ACCESS_TOKEN) || configOutput.includes(ABSOLUTE_PATH)) {
      throw new Error("authenticated config exposed a forbidden protected value");
    }

    const refreshServer = await startFakeAliyunServer({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: `${REFRESH_TOKEN} ${ACCESS_TOKEN}`,
      },
    });
    aliyunServers.push(refreshServer);
    const expiredVault = memoryVault(record("2000-01-01T00:00:00.000Z"));
    const refreshRuntime = orchestratorFor(refreshServer, expiredVault);
    const refreshResult = await toolFor(
      refreshRuntime.orchestrator,
      workspace,
    ).execute("refresh-failure", { paths: ["report.txt"] });
    expect(refreshResult.details).toEqual({ code: "REFRESH_TOKEN_REJECTED" });

    const uploadServer = await startFakeAliyunServer([
      {
        status: 200,
        body: { default_drive_id: "drive-1", user_id: "user-1" },
      },
      {
        status: 500,
        body: { message: `${ACCESS_TOKEN} ${ABSOLUTE_PATH}` },
      },
    ]);
    aliyunServers.push(uploadServer);
    const uploadRuntime = orchestratorFor(uploadServer, memoryVault(record()));
    const uploadResult = await toolFor(
      uploadRuntime.orchestrator,
      workspace,
    ).execute("upload-failure", {
      paths: [ABSOLUTE_PATH, "report.txt"],
    });
    expect(uploadResult.details).toEqual({
      provider: "aliyun",
      remoteDirectory: "/",
      status: "failed",
      files: [
        {
          inputName: "invalid-path",
          status: "failed",
          errorCode: "WORKSPACE_PATH_REJECTED",
        },
        {
          inputName: "report.txt",
          status: "failed",
          errorCode: "UPLOAD_FAILED",
        },
      ],
    });

    const statusOutput = await invokeRoute(createPanSyncStatusRoute({
      store: { read: async () => saved },
      tokenManager: { statusForSnapshot: () => "degraded" },
      config: { defaultDirectory: "/openClawShare" },
    }));
    const loggerCalls: unknown[][] = [];
    const logger = {
      debug: (...values: unknown[]) => loggerCalls.push(values),
      info: (...values: unknown[]) => loggerCalls.push(values),
      warn: (...values: unknown[]) => loggerCalls.push(values),
      error: (...values: unknown[]) => loggerCalls.push(values),
    };
    await exercisePluginLoggerBoundary(
      path.join(root, "plugin-state"),
      workspace,
      logger,
    );
    expect(loggerCalls).toEqual([]);

    assertNoProtectedArguments("invalid credentials response", [invalidOutput]);
    assertNoProtectedArguments("refresh failure Tool result", [refreshResult]);
    assertNoProtectedArguments("path and upload Tool result", [uploadResult]);
    assertNoProtectedArguments("status HTML", [statusOutput]);
    assertNoProtectedArguments("actual OpenClaw logger calls", loggerCalls);
    assertNoProtectedArguments(
      "simulated host logging of projected Tool results",
      [refreshResult, uploadResult],
    );
  });
});
