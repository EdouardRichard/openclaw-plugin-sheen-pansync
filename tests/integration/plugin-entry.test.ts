import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginService,
  OpenClawPluginToolFactory,
  PluginControlUiDescriptor,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPanSyncPluginEntry,
  default as panSyncPlugin,
} from "../../src/index.js";
import { bindFetchSafeLoopbackServer } from "../../src/net/fetch-safe-loopback.js";
import { createPanSyncStatusRoute } from "../../src/admin/status-route.js";
import {
  type CredentialLeaseRunner,
  CredentialStore,
} from "../../src/credentials/store.js";
import {
  TokenManager,
  type TokenManagerStatus,
} from "../../src/credentials/token-manager.js";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { createTempState, octalMode } from "../helpers/temp-state.js";
import { createBuiltPackageFixture } from "../helpers/package-fixture.js";
import { withOpenClawInstallLease } from "../helpers/openclaw-install-lease.mjs";

type ToolFactory = OpenClawPluginToolFactory;

type CliRegistrar = Parameters<OpenClawPluginApi["registerCli"]>[0];

type CliCommand = {
  command(spec: string): CliCommand;
  description(text: string): CliCommand;
  action(handler: () => void | Promise<void>): CliCommand;
};

type Registrations = {
  tools: string[];
  toolFactories: ToolFactory[];
  cliCommands: string[];
  cliRegistrars: CliRegistrar[];
  httpRoutes: Array<{
    path: string;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    handler: OpenClawPluginHttpRouteHandler;
  }>;
  controlUi: PluginControlUiDescriptor[];
  services: OpenClawPluginService[];
  gatewayMethods: string[];
  privilegedStateCalls: string[];
};

class CommandRecorder implements CliCommand {
  readonly children = new Map<string, CommandRecorder>();
  handler: (() => void | Promise<void>) | undefined;

  command(spec: string): CommandRecorder {
    const child = new CommandRecorder();
    this.children.set(spec, child);
    return child;
  }

  description(_text: string): CommandRecorder {
    return this;
  }

  action(handler: () => void | Promise<void>): CommandRecorder {
    this.handler = handler;
    return this;
  }
}

const immediateLease: CredentialLeaseRunner = (_key, run) => run({
  assertOwned: async () => undefined,
});
const cleanups: Array<() => Promise<void>> = [];
const require = createRequire(import.meta.url);

function registerPlugin(
  plugin: OpenClawPluginDefinition,
  api: OpenClawPluginApi,
): void {
  if (plugin.register === undefined) throw new Error("plugin register missing");
  plugin.register(api);
}

function pluginConfigSchema(
  plugin: OpenClawPluginDefinition,
): OpenClawPluginConfigSchema {
  if (plugin.configSchema === undefined) {
    throw new Error("plugin config schema missing");
  }
  return plugin.configSchema;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function credentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    formatVersion: 2,
    credentialVersion: 1,
    authorizationPageUrl: "http://auth.example.test/custom",
    refreshApiUrl: "http://refresh.example.test/custom/renew",
    refreshToken: "refresh-token-CANARY",
    accessToken: "access-token-CANARY",
    account: {
      userIdMasked: "use***89",
      displayNameMasked: "<&***",
    },
    lastVerifiedAt: "2026-07-31T00:00:00.000Z",
    refreshState: { status: "ready" },
    ...overrides,
  };
}

function fakeApi(
  stateDir: string,
  pluginConfig: Record<string, unknown> = {},
): { api: OpenClawPluginApi; registrations: Registrations } {
  const registrations: Registrations = {
    tools: [],
    toolFactories: [],
    cliCommands: [],
    cliRegistrars: [],
    httpRoutes: [],
    controlUi: [],
    services: [],
    gatewayMethods: [],
    privilegedStateCalls: [],
  };
  const privileged = (name: string): never => {
    registrations.privilegedStateCalls.push(name);
    throw new Error(`privileged state call: ${name}`);
  };
  const api = {
    id: "pan-sync-helper",
    name: "Pan Sync Helper",
    source: "integration-test",
    registrationMode: "full",
    config: {
      stateDir: "D:\\forged-config-state-CANARY",
      credentials: {
        client_secret: "config-secret-CANARY",
      },
    },
    pluginConfig,
    rootDir: process.cwd(),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    runtime: {
      state: {
        resolveStateDir: vi.fn(() => stateDir),
        withLease: () => privileged("withLease"),
        openKeyedStore: () => privileged("openKeyedStore"),
        openSyncKeyedStore: () => privileged("openSyncKeyedStore"),
      },
    },
    registerTool(tool: ToolFactory, options?: { name?: string }) {
      registrations.tools.push(options?.name ?? "");
      registrations.toolFactories.push(tool);
    },
    registerCli(registrar: CliRegistrar, options?: {
      descriptors?: Array<{ name: string }>;
    }) {
      registrations.cliRegistrars.push(registrar);
      registrations.cliCommands.push(
        ...(options?.descriptors?.map(({ name }) => name) ?? []),
      );
    },
    registerHttpRoute(route: Registrations["httpRoutes"][number]) {
      registrations.httpRoutes.push(route);
    },
    registerService(service: OpenClawPluginService) {
      registrations.services.push(service);
    },
    registerGatewayMethod(method: string) {
      registrations.gatewayMethods.push(method);
    },
    session: {
      controls: {
        registerControlUiDescriptor(descriptor: PluginControlUiDescriptor) {
          registrations.controlUi.push(descriptor);
        },
      },
    },
  } as unknown as OpenClawPluginApi;
  return { api, registrations };
}

async function invokeRoute(
  handler: OpenClawPluginHttpRouteHandler,
  method: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const { server, address } = await bindFetchSafeLoopbackServer({
    createServer: () => createServer((request, response) => {
      void Promise.resolve(handler(request, response)).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/status`, {
      method,
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function registeredStatusRoute(registrations: Registrations) {
  const route = registrations.httpRoutes.find(
    ({ path: registeredPath }) =>
      registeredPath === "/plugins/pan-sync-helper/status",
  );
  if (route === undefined) throw new Error("status route not registered");
  return route.handler;
}

function registeredToolFactory(registrations: Registrations): ToolFactory {
  const factory = registrations.toolFactories[0];
  if (factory === undefined) throw new Error("tool factory not registered");
  return factory;
}

async function runCliRegistrar(registrar: CliRegistrar): Promise<CommandRecorder> {
  const root = new CommandRecorder();
  await registrar({
    program: root as never,
    parentPath: [],
    config: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  } as never);
  return root;
}

describe("read-only status route", () => {
  it("whitelist-projects and escapes a populated Vault without credential disclosure", async () => {
    const state = await createTempState();
    cleanups.push(state.cleanup);
    const store = new CredentialStore(state.dataDir, immediateLease);
    const record = {
      ...credentialRecord(),
      rawUserId: "raw-user-id-CANARY",
      officialResponseContent: "official-response-CANARY",
    } as CredentialRecord;
    await store.replace(record);
    const handler = createPanSyncStatusRoute({
      store,
      tokenManager: { statusForSnapshot: () => "ready" },
      config: { defaultDirectory: "/openClawShare" },
    });

    const response = await invokeRoute(handler, "GET");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.body).toContain("aliyun");
    expect(response.body).toContain("ready");
    expect(response.body).toContain("OpenList");
    expect(response.body).toContain("&lt;&amp;***");
    expect(response.body).toContain("/openClawShare");
    expect(response.body).toContain("openclaw pan-sync configure");
    expect(response.body).not.toMatch(/client_secret|refresh_token|access_token/u);
    expect(response.body).not.toContain("client_id");
    expect(response.body).not.toContain(record.authorizationPageUrl);
    expect(response.body).not.toContain(record.refreshApiUrl);
    expect(response.body).not.toContain(record.refreshToken);
    expect(response.body).not.toContain(record.accessToken);
    expect(response.body).not.toContain("raw-user-id-CANARY");
    expect(response.body).not.toContain("official-response-CANARY");
    expect(response.body).not.toContain("<script");
    expect(response.body).not.toMatch(/\s(?:src|href|onload)=/u);
    expect(response.body).not.toMatch(/https?:\/\//u);
  });

  it.each([
    "unconfigured",
    "ready",
    "degraded",
    "rate_limited",
    "reauth_required",
  ] satisfies TokenManagerStatus[])("renders the bounded %s state", async (status) => {
    const handler = createPanSyncStatusRoute({
      store: {
        read: async () => status === "unconfigured"
          ? undefined
          : credentialRecord(),
      },
      tokenManager: { statusForSnapshot: () => status },
      config: { defaultDirectory: "/openClawShare" },
    });

    const response = await invokeRoute(handler, "GET");

    expect(response.status).toBe(200);
    expect(response.body).toContain(status);
  });

  it("allows only GET and HEAD, emits no HEAD body, and secures rejection responses", async () => {
    const handler = createPanSyncStatusRoute({
      store: { read: async () => undefined },
      tokenManager: { statusForSnapshot: () => "unconfigured" },
      config: { defaultDirectory: "/openClawShare" },
    });

    const head = await invokeRoute(handler, "HEAD");
    const post = await invokeRoute(handler, "POST");

    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(post.headers.get("cache-control")).toBe("no-store");
    expect(post.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(post.body).toBe("");
  });

  it("maps native status failures to degraded without exposing their details", async () => {
    const handler = createPanSyncStatusRoute({
      store: {
        read: async () => {
          throw new Error("native-status-CANARY D:\\secret\\credentials.enc");
        },
      },
      tokenManager: {
        statusForSnapshot: () => {
          throw new Error("upstream-body-CANARY");
        },
      },
      config: { defaultDirectory: "/openClawShare<script>" },
    });

    const response = await invokeRoute(handler, "GET");

    expect(response.status).toBe(200);
    expect(response.body).toContain("degraded");
    expect(response.body).toContain("/openClawShare&lt;script&gt;");
    expect(response.body).not.toContain("native-status-CANARY");
    expect(response.body).not.toContain("upstream-body-CANARY");
  });

  it("renders status and credential projection from one coherent Vault snapshot", async () => {
    const configured = credentialRecord();
    let reads = 0;
    const vault = {
      async read() {
        reads += 1;
        return reads === 1 ? configured : undefined;
      },
      async replaceIfVersion() {
        return false;
      },
    };
    const tokenManager = new TokenManager({
      store: vault,
      tokenService: { refresh: vi.fn() },
      runWithRefreshLease: immediateLease,
    });
    const handler = createPanSyncStatusRoute({
      store: vault as never,
      tokenManager,
      config: { defaultDirectory: "/openClawShare" },
    });

    const response = await invokeRoute(handler, "GET");

    expect(reads).toBe(1);
    expect(response.body).toContain("ready");
    expect(response.body).toContain("Configured</dt><dd>yes");
    expect(response.body).toContain("OpenList");
  });
});

describe("OpenClaw plugin entry", () => {
  it("registers the exact Tool, CLI, gateway route, Control UI, and service metadata", () => {
    const { api, registrations } = fakeApi("D:\\runtime-state");

    registerPlugin(panSyncPlugin, api);

    expect(registrations.tools).toContain("pan_sync_upload");
    expect(registrations.cliCommands).toContain("pan-sync");
    expect(registrations.httpRoutes).toContainEqual(
      expect.objectContaining({
        path: "/plugins/pan-sync-helper/status",
        auth: "gateway",
        match: "exact",
      }),
    );
    expect(registrations.controlUi).toEqual([{
      surface: "tab",
      id: "pan-sync-helper",
      label: "Pan Sync Helper",
      requiredScopes: ["operator.write"],
      path: "/plugins/pan-sync-helper/status",
    }]);
    expect(registrations.services.map(({ id }) => id)).toEqual([
      "pan-sync-helper",
    ]);
    expect(registrations.gatewayMethods).toEqual([]);
    expect(registrations.privilegedStateCalls).toEqual([]);
  });

  it("parses only plugin-owned non-secret config", () => {
    const configSchema = pluginConfigSchema(panSyncPlugin);
    expect(configSchema.safeParse?.({ defaultDirectory: "/reports" })).toMatchObject({
      success: true,
      data: {
        defaultDirectory: "/reports",
      },
    });
    expect(configSchema.safeParse?.({
      tokenGuideUrl: "https://example.test/guide",
    })).toMatchObject({ success: false });
    expect(configSchema.safeParse?.({
      clientSecret: "config-secret-CANARY",
    })).toMatchObject({ success: false });
    const { api } = fakeApi("D:\\runtime-state", {
      refresh_token: "config-refresh-CANARY",
    });

    expect(() => registerPlugin(panSyncPlugin, api)).toThrow(
      "unknown configuration key",
    );
  });

  it("uses one shared composition, runtime state authority, and lifecycle snapshots", async () => {
    const state = await createTempState();
    cleanups.push(state.cleanup);
    const dataDir = path.join(state.dataDir, "pan-sync-helper");
    let capturedSetupDependencies: import("../../src/admin/setup-server.js").SetupServerDependencies | undefined;
    let capturedLeaseDatabasePath: string | undefined;
    let leaseFactoryCalls = 0;
    const leaseKeys: string[] = [];
    const writes: string[] = [];
    const entry = createPanSyncPluginEntry({
      credentialLeaseFactory(databasePath) {
        leaseFactoryCalls += 1;
        capturedLeaseDatabasePath = databasePath;
        return async (key, run) => {
          leaseKeys.push(key);
          await mkdir(path.dirname(databasePath), {
            recursive: true,
            mode: 0o700,
          });
          return run({ assertOwned: async () => undefined });
        };
      },
      configureCliOptions: {
        async startServer(dependencies) {
          capturedSetupDependencies = dependencies;
          return {
            url: "http://127.0.0.1:43210/#test-key",
            port: 43210,
            accessKeyBuffer: Buffer.alloc(32),
            closed: Promise.resolve(),
            close: async () => undefined,
            isAuthorized: () => false,
          };
        },
        writeLine(line) {
          writes.push(line);
        },
        processEvents: {
          once: vi.fn(),
          off: vi.fn(),
        },
      },
    });
    const { api, registrations } = fakeApi(state.dataDir, {
      defaultDirectory: "/openClawShare",
    });
    registerPlugin(entry, api);
    const service = registrations.services[0];
    if (service === undefined) throw new Error("service not registered");

    await service.start({
      config: {},
      stateDir: "D:\\forged-service-state-CANARY",
      logger: api.logger,
    });

    expect((await stat(dataDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(dataDir, "locks"))).isDirectory()).toBe(true);
    expect(capturedLeaseDatabasePath).toBe(
      path.join(dataDir, "locks", "lease.sqlite"),
    );
    expect(leaseFactoryCalls).toBe(1);
    if (process.platform !== "win32") {
      expect(await octalMode(dataDir)).toBe("700");
      expect(await octalMode(path.join(dataDir, "locks"))).toBe("700");
    }
    await expect(stat("D:\\forged-config-state-CANARY")).rejects.toBeDefined();
    await expect(stat("D:\\forged-service-state-CANARY")).rejects.toBeDefined();

    const registrar = registrations.cliRegistrars[0];
    if (registrar === undefined) throw new Error("CLI not registered");
    const root = await runCliRegistrar(registrar);
    const configure = root.children.get("pan-sync")?.children.get("configure")
      ?.handler;
    if (configure === undefined) throw new Error("configure action missing");
    await configure();
    const setup = capturedSetupDependencies;
    if (setup === undefined) throw new Error("setup dependencies not captured");
    expect(setup.dataDir).toBe(dataDir);
    expect(writes).toContain(
      "Pan Sync Helper configuration page is ready for 10 minutes.",
    );

    await setup.store.replaceIfVersion(undefined, credentialRecord());
    const ready = await invokeRoute(
      registeredStatusRoute(registrations),
      "GET",
    );
    expect(ready.body).toContain("ready");

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://refresh.example.test/custom/renew")) {
        return new Response(JSON.stringify({ error: "upstream-body-CANARY" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: "AccessTokenExpired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }));
    const tool = registeredToolFactory(registrations)({
      workspaceDir: path.join(state.dataDir, "workspace"),
    } as never) as {
      execute(callId: string, input: { paths: string[] }): Promise<{
        details?: { code?: string };
      }>;
    };
    const failed = await tool.execute("call-1", { paths: ["report.pdf"] });
    expect(failed.details).toEqual({ code: "TOKEN_ENDPOINT_UNAVAILABLE" });
    vi.unstubAllGlobals();
    const afterProviderFailure = await invokeRoute(
      registeredStatusRoute(registrations),
      "GET",
    );
    expect(afterProviderFailure.body).toContain("degraded");
    expect(afterProviderFailure.body).not.toContain("upstream-body-CANARY");
    expect(leaseKeys).toContain("aliyun-token-refresh");

    const persistedFailure = await setup.store.read();
    if (persistedFailure === undefined) {
      throw new Error("persisted failure missing");
    }
    const explicitRefreshRequests: string[] = [];
    const {
      server: explicitRefreshServer,
      address: explicitAddress,
    } = await bindFetchSafeLoopbackServer({
      createServer: () => createServer((request, response) => {
        explicitRefreshRequests.push(request.url ?? "");
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid explicit token" }));
      }),
    });
    try {
      await expect(setup.provider.validateCredentials({
        authorizationPageUrl: persistedFailure.authorizationPageUrl,
        refreshApiUrl: `http://127.0.0.1:${explicitAddress.port}/refresh`,
        refreshToken: "refresh-explicit-submission",
        credentialVersion: persistedFailure.credentialVersion + 1,
      })).rejects.toMatchObject({ code: "REFRESH_TOKEN_REJECTED" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        explicitRefreshServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
    expect(explicitRefreshRequests).toHaveLength(1);
    await expect(setup.store.read()).resolves.toEqual(persistedFailure);

    await service.stop?.({
      config: {},
      stateDir: "D:\\forged-service-state-CANARY",
      logger: api.logger,
    });
    const reset = await invokeRoute(
      registeredStatusRoute(registrations),
      "GET",
    );
    expect(reset.body).toContain("degraded");
    await expect(setup.store.read()).resolves.toEqual(
      expect.objectContaining({ authorizationPageUrl: "http://auth.example.test/custom" }),
    );
  });

  it(
    "installs and registers the actual package artifact in OpenClaw without privileged state access",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "pan-sync-entry-runtime-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const stateDir = path.join(root, "state");
      await mkdir(stateDir);
      const packageFixture = await createBuiltPackageFixture();
      cleanups.push(packageFixture.cleanup);
      const npmCli = process.env.npm_execpath;
      if (npmCli === undefined) throw new Error("npm CLI path unavailable");
      const runNpm = (args: string[]) => spawnSync(process.execPath, [
        npmCli,
        ...args,
      ], {
        cwd: packageFixture.root,
        encoding: "utf8",
        timeout: 45_000,
      });
      const pack = runNpm([
        "pack",
        "--json",
        "--pack-destination",
        root,
      ]);
      expect(pack.error).toBeUndefined();
      expect(pack.status, `${pack.stdout}\n${pack.stderr}`).toBe(0);
      const packed = JSON.parse(pack.stdout) as Array<{
        filename?: string;
        files?: Array<{ path?: string }>;
      }>;
      const filename = packed[0]?.filename;
      if (filename === undefined) throw new Error("package artifact missing");
      const packedPaths = packed[0]?.files?.map(({ path }) => path) ?? [];
      expect(packedPaths).toContain(
        "dist/credentials/sqlite-worker-lease.js",
      );
      expect(packedPaths).not.toContain(
        "dist/credentials/filesystem-lease.js",
      );
      const packageArtifact = path.join(root, filename);

      const runOpenClaw = (args: string[]) => {
        const cliPath = require.resolve("openclaw/cli-entry");
        const nodeVersion = process.versions.node.split(".").map(Number);
        const supported = (nodeVersion[0] ?? 0) > 22
          || ((nodeVersion[0] ?? 0) === 22 && (nodeVersion[1] ?? 0) >= 22);
        const command = supported ? process.execPath : "volta";
        const commandArgs = supported
          ? [cliPath, ...args]
          : ["run", "--node", "22.23.1", "node", cliPath, ...args];
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NODE_ENV: "production",
          NO_COLOR: "1",
          OPENCLAW_STATE_DIR: stateDir,
        };
        delete env.VITEST;
        delete env.VITEST_POOL_ID;
        delete env.VITEST_WORKER_ID;
        return spawnSync(command, commandArgs, {
          cwd: process.cwd(),
          env,
          encoding: "utf8",
          timeout: 90_000,
        });
      };

      const install = await withOpenClawInstallLease(() =>
        runOpenClaw(["plugins", "install", packageArtifact])
      );
      expect(install.error).toBeUndefined();
      expect(install.status, install.stderr).toBe(0);
      const inspect = runOpenClaw([
        "plugins",
        "inspect",
        "pan-sync-helper",
        "--runtime",
        "--json",
      ]);
      expect(inspect.error).toBeUndefined();
      expect(inspect.status, inspect.stderr).toBe(0);
      const result = JSON.parse(inspect.stdout) as {
        diagnostics?: Array<{ level?: string; message?: string }>;
        plugin?: { toolNames?: string[] };
      };
      expect(
        result.diagnostics?.filter(({ level }) => level === "error") ?? [],
      ).toEqual([]);
      expect(result.plugin?.toolNames).toContain("pan_sync_upload");
      expect(inspect.stderr).not.toContain(
        "openKeyedStore is only available for trusted plugins",
      );
    },
    360_000,
  );
});
