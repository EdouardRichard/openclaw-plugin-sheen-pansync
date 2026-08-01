import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { types as nodeTypes } from "node:util";
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
import { OpenListTokenService } from "../../src/providers/aliyun/openlist-token-service.js";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";
import { registerPanSyncUploadTool, type PanSyncUploadToolApi } from "../../src/tool.js";
import { UploadOrchestrator } from "../../src/upload/orchestrator.js";
import { startFakeAliyunServer, type FakeAliyunServer } from "../helpers/fake-aliyun-server.js";

const CLIENT_SECRET = "client-secret-CANARY-8b26";
const REFRESH_TOKEN = "refresh-token-CANARY-19d4";
const ACCESS_TOKEN = "access-token-CANARY-62a1";
const ABSOLUTE_PATH = "/srv/private/openclaw/workspace/report.pdf";
const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const MAP_FOR_EACH_INTRINSIC = Map.prototype.forEach;
const SET_FOR_EACH_INTRINSIC = Set.prototype.forEach;
const PROTECTED_ASSERTION_FAILURE = Object.freeze(
  new Error("protected value detected"),
);
const UNEXPECTED_LOGGER_CALL_FAILURE = Object.freeze(
  new Error("unexpected production logger calls"),
);
type RejectionKind = "none" | "protected" | "unexpected" | "unsafe";

const cleanups: Array<() => Promise<void>> = [];
const runningServers: SetupServer[] = [];
const aliyunServers: FakeAliyunServer[] = [];

function record(
  refreshState: CredentialRecord["refreshState"] = { status: "ready" },
): CredentialRecord {
  return {
    formatVersion: 2,
    credentialVersion: 1,
    authorizationPageUrl: "http://auth.example.test/custom",
    refreshApiUrl: "http://refresh.example.test/custom/renew",
    refreshToken: REFRESH_TOKEN,
    accessToken: ACCESS_TOKEN,
    account: { userIdMasked: "use***42", displayNameMasked: "R***" },
    lastVerifiedAt: "2026-08-01T00:00:00.000Z",
    refreshState,
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
  const tokenService = new OpenListTokenService({
    clock: () => NOW,
  });
  const tokenManager = new TokenManager({
    store: vault,
    tokenService,
    clock: () => NOW,
  });
  const provider = new AliyunProvider({
    tokenService,
    tokenManager,
    baseUrl: server.baseUrl,
    clock: () => NOW,
  });
  return {
    tokenService,
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
  const maxErrorPrototypeDepth = 32;
  const pending = [...values];
  const seen = new WeakSet<object>();
  const safeTypeCheck = (
    check: (value: unknown) => boolean,
    value: unknown,
  ): boolean | "unsafe" => {
    try {
      return check(value);
    } catch {
      return "unsafe";
    }
  };
  const queueDescriptor = (
    target: object,
    key: PropertyKey,
  ): "missing" | "queued" | "unsafe" => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(target, key);
    } catch {
      return "unsafe";
    }
    if (descriptor === undefined) return "missing";
    if (!("value" in descriptor)) return "unsafe";
    pending.push(descriptor.value);
    return "queued";
  };
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
      try {
        pending.push(String(value));
      } catch {
        return true;
      }
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

    const isNativeError = safeTypeCheck(nodeTypes.isNativeError, value);
    const isMap = safeTypeCheck(nodeTypes.isMap, value);
    const isSet = safeTypeCheck(nodeTypes.isSet, value);
    const isProxy = safeTypeCheck(nodeTypes.isProxy, value);
    if (
      isNativeError === "unsafe"
      || isMap === "unsafe"
      || isSet === "unsafe"
      || isProxy === "unsafe"
    ) {
      return true;
    }

    if (isNativeError) {
      for (const field of ["name", "message", "stack", "cause"] as const) {
        let target: object | null = value;
        const visited = new WeakSet<object>();
        let depth = 0;
        while (target !== null) {
          if (visited.has(target) || depth >= maxErrorPrototypeDepth) {
            return true;
          }
          visited.add(target);
          depth += 1;
          const result = queueDescriptor(target, field);
          if (result === "unsafe") return true;
          if (result === "queued") break;
          try {
            target = Object.getPrototypeOf(target) as object | null;
          } catch {
            return true;
          }
        }
      }
    }
    if (isMap) {
      try {
        Reflect.apply(MAP_FOR_EACH_INTRINSIC, value, [
          (entry: unknown, key: unknown) => pending.push(key, entry),
        ]);
      } catch {
        return true;
      }
    }
    if (isSet) {
      try {
        Reflect.apply(SET_FOR_EACH_INTRINSIC, value, [
          (entry: unknown) => pending.push(entry),
        ]);
      } catch {
        return true;
      }
    }

    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      return true;
    }
    for (const key of keys) {
      pending.push(key);
      if (queueDescriptor(value, key) === "unsafe") return true;
    }
    if (isProxy) return true;
  }
  return false;
}

function assertNoProtectedArguments(values: readonly unknown[]): void {
  if (containsProtectedValue(values)) {
    throw PROTECTED_ASSERTION_FAILURE;
  }
}

function assertNoProductionLoggerCalls(calls: readonly unknown[][]): void {
  assertNoProtectedArguments(calls);
  if (calls.length !== 0) {
    throw UNEXPECTED_LOGGER_CALL_FAILURE;
  }
}

function rejectionKind(run: () => void): RejectionKind {
  try {
    run();
    return "none";
  } catch (error) {
    if (error === PROTECTED_ASSERTION_FAILURE) return "protected";
    if (error === UNEXPECTED_LOGGER_CALL_FAILURE) return "unexpected";
    return "unsafe";
  }
}

function assertRejectedWithoutDumping(value: unknown): void {
  if (rejectionKind(() => assertNoProtectedArguments([value])) !== "protected") {
    throw new Error("protected value was not rejected safely");
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
    assertRejectedWithoutDumping(createValue());
  });

  it("handles clean cyclic logger arguments", () => {
    const value: Record<string, unknown> = { nested: ["safe"] };
    value.self = value;
    if (rejectionKind(() => assertNoProtectedArguments([value])) !== "none") {
      throw new Error("clean cyclic logger arguments were rejected");
    }
  });

  it("fails closed on an enumerable accessor without invoking its getter", () => {
    let getterCalls = 0;
    const value = {};
    Object.defineProperty(value, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return ACCESS_TOKEN;
      },
    });

    assertRejectedWithoutDumping(value);
    expect(getterCalls).toBe(0);
  });

  it("does not invoke a customized Error accessor", () => {
    let getterCalls = 0;
    const error = new Error("safe message");
    error.stack = "safe stack";
    const prototype = Object.create(Error.prototype) as object;
    Object.defineProperty(prototype, "name", {
      get() {
        getterCalls += 1;
        return CLIENT_SECRET;
      },
    });
    Object.setPrototypeOf(error, prototype);

    assertRejectedWithoutDumping(error);
    expect(getterCalls).toBe(0);
  });

  it.each([
    ["Map", () => new Map([["payload", REFRESH_TOKEN]])],
    ["Set", () => new Set([ABSOLUTE_PATH])],
    ["function own property", () => {
      const value = () => undefined;
      Object.defineProperty(value, "payload", { value: ACCESS_TOKEN });
      return value;
    }],
  ] as const)("inspects %s logger arguments", (_name, createValue) => {
    assertRejectedWithoutDumping(createValue());
  });

  it.each([
    ["Map", Map.prototype, () => new Map([["payload", REFRESH_TOKEN]])],
    ["Set", Set.prototype, () => new Set([ABSOLUTE_PATH])],
  ] as const)(
    "uses the captured %s traversal intrinsic after prototype mutation",
    (name, prototype, createValue) => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        prototype,
        "forEach",
      );
      if (originalDescriptor === undefined) {
        throw new Error(`${name} traversal intrinsic was unavailable`);
      }
      const value = createValue();
      let hostileCalls = 0;
      let protectedValueWasRejected = false;
      try {
        Object.defineProperty(prototype, "forEach", {
          ...originalDescriptor,
          value() {
            hostileCalls += 1;
          },
        });
        try {
          assertRejectedWithoutDumping(value);
          protectedValueWasRejected = true;
        } catch {
          // Do not inspect or expose the captured failure.
        }
      } finally {
        Object.defineProperty(prototype, "forEach", originalDescriptor);
      }
      if (!protectedValueWasRejected) {
        throw new Error(`${name} traversal did not use its captured intrinsic`);
      }
      if (hostileCalls !== 0) {
        throw new Error(`${name} traversal invoked its mutable prototype method`);
      }
    },
  );

  it("scans production logger calls before enforcing zero cardinality", () => {
    const calls = [[{ payload: CLIENT_SECRET }]];
    const kind = rejectionKind(() => assertNoProductionLoggerCalls(calls));
    if (kind !== "protected") {
      throw new Error("production logger failure order was not safe");
    }
  });

  it("uses a fixed failure for clean unexpected production logger calls", () => {
    const kind = rejectionKind(() =>
      assertNoProductionLoggerCalls([[{ event: "safe event" }]])
    );
    if (kind !== "unexpected") {
      throw new Error("production logger cardinality failure was not fixed");
    }
  });

  it("fails closed when ownKeys throws without exposing the trap error", () => {
    let trapCalls = 0;
    const value = new Proxy({}, {
      ownKeys() {
        trapCalls += 1;
        throw new Error(ACCESS_TOKEN);
      },
    });

    assertRejectedWithoutDumping(value);
    expect(trapCalls).toBe(1);
  });

  it("fails closed when Error prototype lookup throws", () => {
    let trapCalls = 0;
    const hostilePrototype = new Proxy({}, {
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error(REFRESH_TOKEN);
      },
    });
    const error = new Error("safe message");
    error.stack = "safe stack";
    Object.setPrototypeOf(error, hostilePrototype);

    assertRejectedWithoutDumping(error);
    expect(trapCalls).toBe(1);
  });

  it.each([
    ["Map", () => new Map()],
    ["Set", () => new Set()],
  ] as const)("avoids %s instanceof prototype traps", (_name, createTarget) => {
    let trapCalls = 0;
    const value = new Proxy(createTarget(), {
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error(CLIENT_SECRET);
      },
    });

    assertRejectedWithoutDumping(value);
    expect(trapCalls).toBe(0);
  });

  it("fails closed when a property descriptor trap throws", () => {
    let trapCalls = 0;
    const value = new Proxy({}, {
      ownKeys: () => ["payload"],
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error(ABSOLUTE_PATH);
      },
    });

    assertRejectedWithoutDumping(value);
    expect(trapCalls).toBe(1);
  });

  it("bounds a cyclic exotic Error prototype traversal", () => {
    let trapCalls = 0;
    let cyclicPrototype: object;
    cyclicPrototype = new Proxy({}, {
      getPrototypeOf() {
        trapCalls += 1;
        if (trapCalls > 8) throw new Error(ACCESS_TOKEN);
        return cyclicPrototype;
      },
    });
    const error = new Error("safe message");
    error.stack = "safe stack";
    Object.setPrototypeOf(error, cyclicPrototype);

    assertRejectedWithoutDumping(error);
    expect(trapCalls).toBeLessThanOrEqual(2);
  });

  it("classifies hostile thrown values without reflection", () => {
    let prototypeTrapCalls = 0;
    let descriptorTrapCalls = 0;
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        prototypeTrapCalls += 1;
        throw new Error(CLIENT_SECRET);
      },
      getOwnPropertyDescriptor() {
        descriptorTrapCalls += 1;
        throw new Error(REFRESH_TOKEN);
      },
    });
    let observed: RejectionKind;
    try {
      observed = rejectionKind(() => {
        throw hostile;
      });
    } catch {
      throw new Error("failure capture propagated a hostile value");
    }
    if (observed !== "unsafe") {
      throw new Error("failure capture did not return its fixed label");
    }
    expect(prototypeTrapCalls).toBe(0);
    expect(descriptorTrapCalls).toBe(0);
  });

  it("does not return an attacker-controlled own message data value", () => {
    const hostile = {};
    Object.defineProperty(hostile, "message", {
      value: CLIENT_SECRET,
      enumerable: true,
    });
    let observed: RejectionKind;
    try {
      observed = rejectionKind(() => {
        throw hostile;
      });
    } catch {
      throw new Error("failure capture propagated a hostile message value");
    }
    if (observed !== "unsafe") {
      throw new Error("failure capture returned hostile message data");
    }
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
        authorizationPageUrl: "http://auth.example.test/custom",
        refreshApiUrl: `${invalidServer.baseUrl}/custom/renew`,
        refreshToken: saved.refreshToken,
      }),
    });
    const invalidOutput = await invalidResponse.text();
    assertNoProtectedArguments([invalidOutput]);
    let invalidPayload: unknown;
    try {
      invalidPayload = JSON.parse(invalidOutput);
    } catch {
      throw new Error("invalid credentials response was not JSON");
    }
    assertNoProtectedArguments([invalidPayload]);
    expect(invalidResponse.status).toBe(400);
    expect(invalidPayload).toEqual({ code: "REFRESH_TOKEN_REJECTED" });

    const configResponse = await setupRequest(setup, "/api/config");
    const configOutput = await configResponse.text();
    expect(configResponse.status).toBe(200);
    expect(configOutput.includes(CLIENT_SECRET)).toBe(false);
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
    const expiredVault = memoryVault(record({
      status: "reauth_required",
      failureCode: "REFRESH_TOKEN_REJECTED",
    }));
    const refreshRuntime = orchestratorFor(refreshServer, expiredVault);
    const refreshResult = await toolFor(
      refreshRuntime.orchestrator,
      workspace,
    ).execute("refresh-failure", { paths: ["report.txt"] });
    assertNoProtectedArguments([refreshResult]);
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
    assertNoProtectedArguments([uploadResult]);
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
    assertNoProtectedArguments([statusOutput]);
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
    assertNoProductionLoggerCalls(loggerCalls);

    assertNoProtectedArguments([refreshResult, uploadResult]);
  });
});
