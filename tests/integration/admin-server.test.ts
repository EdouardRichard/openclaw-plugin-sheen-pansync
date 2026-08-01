import {
  createServer as nodeCreateServer,
  request as nodeRequest,
  type Server,
} from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { PanSyncError } from "../../src/errors.js";
import { OpenListTokenService } from "../../src/providers/aliyun/openlist-token-service.js";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";
import { UploadOrchestrator } from "../../src/upload/orchestrator.js";
import {
  startSetupServer,
  type SetupServerDependencies,
  type SetupServerRuntime,
} from "../../src/admin/setup-server.js";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
} as const;

const savedRecord: CredentialRecord = {
  formatVersion: 2,
  credentialVersion: 7,
  authorizationPageUrl: "http://auth.example.test/custom",
  refreshApiUrl: "http://refresh.example.test/custom/renew",
  refreshToken: "refresh-token-saved",
  accessToken: "access-token-saved",
  account: {
    userIdMasked: "use***42",
    displayNameMasked: "A***",
  },
  lastVerifiedAt: "2026-07-31T00:00:00.000Z",
  refreshState: { status: "ready" },
};

type HarnessOptions = {
  record?: CredentialRecord | undefined;
  validate?: SetupServerDependencies["provider"]["validateCredentials"];
  upload?: SetupServerDependencies["orchestrator"]["upload"];
  replaceIfVersion?: (
    expected: number | undefined,
    candidate: CredentialRecord,
    options?: { signal?: AbortSignal },
  ) => Promise<boolean>;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function startDelayedApi(delayedPath: string) {
  const started = deferred();
  const aborted = deferred();
  const requests: string[] = [];
  const server = nodeCreateServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(requestPath);
    if (requestPath === delayedPath) {
      started.resolve();
      request.once("aborted", () => aborted.resolve());
      response.once("close", () => {
        if (!response.writableEnded) aborted.resolve();
      });
      request.resume();
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"code":"UNEXPECTED_REQUEST"}');
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("delayed API unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    started: started.promise,
    aborted: aborted.promise,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createHarness(options: HarnessOptions = {}) {
  let record = options.record;
  const replace = vi.fn(async (candidate: CredentialRecord) => {
    record = structuredClone(candidate);
  });
  const replaceIfVersion = vi.fn(
    options.replaceIfVersion
      ?? (async (
        expected: number | undefined,
        candidate: CredentialRecord,
        mutationOptions?: { signal?: AbortSignal },
      ) => {
        if (mutationOptions?.signal?.aborted === true) {
          return false;
        }
        const currentVersion = record?.credentialVersion;
        if (currentVersion !== expected) {
          return false;
        }
        record = structuredClone(candidate);
        return true;
      }),
  );
  const clear = vi.fn(async () => {
    record = undefined;
  });
  const read = vi.fn(async () =>
    record === undefined ? undefined : structuredClone(record));
  const validateCredentials = vi.fn(
    options.validate
      ?? (async (candidate) => ({
        ...savedRecord,
        credentialVersion: candidate.credentialVersion ?? 1,
        authorizationPageUrl: candidate.authorizationPageUrl,
        refreshApiUrl: candidate.refreshApiUrl,
        refreshToken: `${candidate.refreshToken}-rotated`,
        accessToken: "new-access-token",
      })),
  );
  const upload = vi.fn(
    options.upload
      ?? (async () => ({
        provider: "aliyun" as const,
        remoteDirectory: "/openClawShare",
        status: "success" as const,
        files: [{
          inputName: "setup-test.txt",
          remoteName: "setup-test (1).txt",
          size: 32,
          status: "uploaded" as const,
        }],
      })),
  );
  const root = await mkdtemp(path.join(tmpdir(), "pan-sync-admin-"));
  const deps: SetupServerDependencies = {
    store: { read, replaceIfVersion, clear },
    provider: { validateCredentials },
    orchestrator: { upload },
    dataDir: path.join(root, "data"),
    assetsDir: path.resolve("ui"),
    clock: () => Date.now(),
    randomBytes: (size) => Buffer.alloc(size, 0x5a),
  };
  return {
    deps,
    read,
    replace,
    replaceIfVersion,
    clear,
    validateCredentials,
    upload,
    get record() {
      return record;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function accessKey(url: string): string {
  return url.split("#")[1] ?? "";
}

async function apiRequest(
  baseUrl: string,
  route: string,
  key?: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      ...(key === undefined
        ? {}
        : { authorization: `PanSyncSetup ${key}` }),
      ...init.headers,
    },
  });
}

async function requestWithHost(baseUrl: string, route: string, host: string) {
  const target = new URL(route, baseUrl);
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const request = nodeRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

const runningServers: Array<{ close(): Promise<void> }> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(runningServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

describe("one-time setup server", () => {
  it("binds only to IPv4 loopback and expires the 32-byte fragment key", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    let listenHost: string | undefined;
    let expiry: (() => void) | undefined;
    let now = 1_000;
    harness.deps.clock = () => now;

    const result = await startSetupServer(harness.deps, {
      createServer(handler) {
        const server = nodeCreateServer(handler);
        const originalListen = server.listen.bind(server);
        server.listen = ((...args: Parameters<Server["listen"]>) => {
          listenHost = typeof args[1] === "string" ? args[1] : undefined;
          return originalListen(...args);
        }) as Server["listen"];
        return server;
      },
      scheduleTimeout(callback, delay) {
        expect(delay).toBe(10 * 60 * 1_000);
        expiry = callback;
        return 1;
      },
      cancelTimeout() {},
    });
    runningServers.push(result);

    expect(listenHost).toBe("127.0.0.1");
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[-A-Za-z0-9_]{43}$/);
    expect(result.url).not.toContain("?");

    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    expect((await apiRequest(baseUrl, "/api/config", key)).status).toBe(200);

    now += 10 * 60 * 1_000 + 1;
    expiry?.();
    await expect(result.closed).resolves.toBeUndefined();
    expect(result.isAuthorized(`PanSyncSetup ${key}`)).toBe(false);
    expect(result.accessKeyBuffer.every((byte) => byte === 0)).toBe(true);
  });

  it("rebinds when port zero selects a browser-forbidden port", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    let serverCount = 0;
    let portChecks = 0;
    const result = await startSetupServer(harness.deps, {
      createServer(handler) {
        serverCount += 1;
        return nodeCreateServer(handler);
      },
      isBrowserSafePort() {
        portChecks += 1;
        return portChecks > 1;
      },
    });
    runningServers.push(result);

    expect(serverCount).toBe(2);
    expect((await apiRequest(result.url.split("/#")[0] ?? "", "/")).status).toBe(200);
  });

  it("applies security headers to public, unauthorized, rejected-host, and missing responses", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    const responses = [
      await apiRequest(baseUrl, "/"),
      await apiRequest(baseUrl, "/api/config"),
      await apiRequest(baseUrl, "/missing", key),
      await apiRequest(baseUrl, "/api/config", key, {
        headers: { "x-forwarded-host": "127.0.0.1" },
      }),
    ];
    expect(responses.map(({ status }) => status)).toEqual([200, 401, 404, 400]);
    for (const response of responses) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name)).toBe(value);
      }
    }
    expect(await responses[0]?.text()).not.toContain(savedRecord.refreshToken);

    const rejectedHost = await requestWithHost(baseUrl, "/api/config", "attacker.example");
    expect(rejectedHost.status).toBe(400);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(rejectedHost.headers[name]).toBe(value);
    }
    expect(rejectedHost.body).not.toContain(savedRecord.refreshToken);
  });

  it("authorizes only the exact header and returns full values only on authorized GET", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    for (const authorization of [
      key,
      `Bearer ${key}`,
      `PanSyncSetup  ${key}`,
      `pansyncsetup ${key}`,
      `PanSyncSetup ${key}=`,
    ]) {
      const response = await apiRequest(baseUrl, "/api/config", undefined, {
        headers: { authorization },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(savedRecord.refreshToken);
    }

    const response = await apiRequest(baseUrl, "/api/config", key);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      credentials: {
        authorizationPageUrl: savedRecord.authorizationPageUrl,
        refreshApiUrl: savedRecord.refreshApiUrl,
        refreshToken: savedRecord.refreshToken,
      },
    });
    const serialized = JSON.stringify(await (await apiRequest(baseUrl, "/api/config", key)).json());
    expect(serialized).not.toContain(savedRecord.accessToken);
    expect(serialized).not.toContain("failureCode");
  });

  it("rejects a noncanonical base64url spelling that decodes to the same key bytes", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = alphabet.indexOf(key.at(-1) ?? "");
    const alternate = `${key.slice(0, -1)}${alphabet[(finalIndex + 1) % alphabet.length]}`;
    expect(Buffer.from(alternate, "base64url")).toEqual(Buffer.from(key, "base64url"));

    const response = await apiRequest(baseUrl, "/api/config", alternate);

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(savedRecord.refreshToken);
  });

  it("accepts only the exact selected IPv4 loopback Host with its port", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";

    expect((await requestWithHost(baseUrl, "/", `127.0.0.1:${result.port}`)).status).toBe(200);
    for (const host of [
      "127.0.0.1",
      `127.0.0.1:${result.port + 1}`,
      `localhost:${result.port}`,
      `[::1]:${result.port}`,
    ]) {
      expect((await requestWithHost(baseUrl, "/", host)).status).toBe(400);
    }
  });

  it("projects default OpenList URLs on the first authenticated setup", async () => {
    const harness = await createHarness({ record: undefined });
    harness.deps.defaultDirectory = "/teamShare";
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    const config = await apiRequest(baseUrl, "/api/config", key);
    expect(await config.json()).toEqual({
      configured: false,
      credentials: {
        authorizationPageUrl: "https://api.oplist.org.cn",
        refreshApiUrl: "https://api.oplist.org.cn/alicloud/renewapi",
        refreshToken: "",
      },
      defaultDirectory: "/teamShare",
    });
  });

  it("accepts any syntactically valid configured URLs without network policy", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const candidate = {
      authorizationPageUrl: "custom+auth://user:pass@127.0.0.1:1/authorize",
      refreshApiUrl: "http://user:pass@127.0.0.1:9/renew",
      refreshToken: "policy-owned-by-user",
    };

    const response = await apiRequest(
      result.url.split("/#")[0] ?? "",
      "/api/config",
      accessKey(result.url),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(candidate),
      },
    );

    expect(response.status).toBe(200);
    expect(harness.validateCredentials).toHaveBeenCalledWith({
      ...candidate,
      credentialVersion: 8,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await response.json()).toMatchObject({
      credentials: {
        authorizationPageUrl: candidate.authorizationPageUrl,
        refreshApiUrl: candidate.refreshApiUrl,
        refreshToken: "policy-owned-by-user-rotated",
      },
    });
  });

  it.each([
    ["invalid authorization URL", {
      authorizationPageUrl: "not a URL",
      refreshApiUrl: "http://refresh.example.test/renew",
      refreshToken: "refresh",
    }],
    ["invalid refresh URL", {
      authorizationPageUrl: "http://auth.example.test/authorize",
      refreshApiUrl: "not a URL",
      refreshToken: "refresh",
    }],
    ["legacy or extra fields", {
      authorizationPageUrl: "http://auth.example.test/authorize",
      refreshApiUrl: "http://refresh.example.test/renew",
      refreshToken: "refresh",
      accessToken: "must-not-be-accepted",
    }],
    ["field over 4096 characters", {
      authorizationPageUrl: "http://auth.example.test/authorize",
      refreshApiUrl: "http://refresh.example.test/renew",
      refreshToken: "x".repeat(4097),
    }],
  ] as const)("rejects %s before validation", async (_name, candidate) => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);

    const response = await apiRequest(
      result.url.split("/#")[0] ?? "",
      "/api/config",
      accessKey(result.url),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(candidate),
      },
    );

    expect(response.status).toBe(400);
    expect(harness.validateCredentials).not.toHaveBeenCalled();
    expect(harness.record).toEqual(savedRecord);
  });

  it("validates a candidate before atomically replacing the saved record", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const candidate = {
      authorizationPageUrl: "http://auth.example.test/custom",
      refreshApiUrl: "http://refresh.example.test/custom/renew",
      refreshToken: "candidate-refresh",
    };

    const response = await apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate),
    });

    expect(response.status).toBe(200);
    expect(harness.validateCredentials).toHaveBeenCalledWith({
      ...candidate,
      credentialVersion: 8,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.replaceIfVersion).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ credentialVersion: 8 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.record).toMatchObject({
      credentialVersion: 8,
      authorizationPageUrl: candidate.authorizationPageUrl,
      refreshApiUrl: candidate.refreshApiUrl,
      refreshToken: "candidate-refresh-rotated",
    });
    expect(await response.json()).toMatchObject({
      credentials: {
        authorizationPageUrl: candidate.authorizationPageUrl,
        refreshApiUrl: candidate.refreshApiUrl,
        refreshToken: "candidate-refresh-rotated",
      },
    });
  });

  it("does not overwrite a newer record when the shared lease version check loses a race", async () => {
    const winner = {
      ...savedRecord,
      credentialVersion: 8,
      authorizationPageUrl: "http://winner-auth.example.test/custom",
    };
    let harness!: Awaited<ReturnType<typeof createHarness>>;
    harness = await createHarness({
      record: savedRecord,
      replaceIfVersion: async () => {
        await harness.replace(winner);
        return false;
      },
    });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    const response = await apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorizationPageUrl: "http://stale-auth.example.test/custom",
        refreshApiUrl: "http://stale-refresh.example.test/custom/renew",
        refreshToken: "stale-refresh",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CREDENTIALS_INVALID" });
    expect(harness.record).toEqual(winner);
  });

  it("allows only one concurrent first save to win the absent-state CAS", async () => {
    const validationGate = deferred();
    let validationCalls = 0;
    const harness = await createHarness({
      record: undefined,
      validate: async (candidate) => {
        validationCalls += 1;
        await validationGate.promise;
        return {
          ...savedRecord,
          credentialVersion: candidate.credentialVersion ?? 1,
          authorizationPageUrl: candidate.authorizationPageUrl,
          refreshApiUrl: candidate.refreshApiUrl,
          refreshToken: candidate.refreshToken,
        };
      },
    });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const save = (suffix: string) => apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorizationPageUrl: `http://auth-${suffix}.example.test/custom`,
        refreshApiUrl: `http://refresh-${suffix}.example.test/custom/renew`,
        refreshToken: `refresh-${suffix}`,
      }),
    });

    const first = save("first");
    const second = save("second");
    await vi.waitFor(() => expect(validationCalls).toBe(2));
    validationGate.resolve();
    const responses = await Promise.all([first, second]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.replaceIfVersion).toHaveBeenCalledTimes(2);
    expect([
      "http://auth-first.example.test/custom",
      "http://auth-second.example.test/custom",
    ]).toContain(harness.record?.authorizationPageUrl);
  });

  it("does not resurrect credentials when clear wins a race with an in-flight save", async () => {
    const validationGate = deferred();
    let validationStarted = false;
    const harness = await createHarness({
      record: savedRecord,
      validate: async (candidate) => {
        validationStarted = true;
        await validationGate.promise;
        return {
          ...savedRecord,
          credentialVersion: candidate.credentialVersion ?? 8,
          authorizationPageUrl: candidate.authorizationPageUrl,
          refreshApiUrl: candidate.refreshApiUrl,
          refreshToken: candidate.refreshToken,
        };
      },
    });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const save = apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorizationPageUrl: "http://stale-auth.example.test/custom",
        refreshApiUrl: "http://stale-refresh.example.test/custom/renew",
        refreshToken: "stale-refresh",
      }),
    });
    await vi.waitFor(() => expect(validationStarted).toBe(true));

    const cleared = await apiRequest(baseUrl, "/api/config", key, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "CLEAR" }),
    });
    validationGate.resolve();
    const saved = await save;

    expect(cleared.status).toBe(200);
    expect(saved.status).toBe(409);
    expect(harness.record).toBeUndefined();
  });

  it("preserves the old Vault and authorization when official candidate validation fails", async () => {
    const rawOfficialBody = "official-body-client-secret-CANARY";
    const harness = await createHarness({
      record: savedRecord,
      validate: async () => {
        const failure = new PanSyncError("REFRESH_TOKEN_REJECTED");
        (failure as Error & { raw?: string }).raw = rawOfficialBody;
        throw failure;
      },
    });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    const failed = await apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorizationPageUrl: "http://candidate-auth.example.test/custom",
        refreshApiUrl: "http://candidate-refresh.example.test/custom/renew",
        refreshToken: "mismatched-refresh",
      }),
    });

    expect(failed.status).toBe(400);
    const failedBody = await failed.text();
    expect(JSON.parse(failedBody)).toEqual({ code: "REFRESH_TOKEN_REJECTED" });
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.record).toEqual(savedRecord);
    expect(failedBody).not.toContain(rawOfficialBody);
    expect((await apiRequest(baseUrl, "/api/config", key)).status).toBe(200);
  });

  it("expires an in-flight GET promptly without echoing credentials", async () => {
    const readStarted = deferred();
    const readGate = deferred<CredentialRecord | undefined>();
    const harness = await createHarness({ record: savedRecord });
    harness.deps.store.read = vi.fn(async () => {
      readStarted.resolve();
      return readGate.promise;
    });
    cleanups.push(harness.cleanup);
    let now = 10_000;
    let expire: (() => void) | undefined;
    harness.deps.clock = () => now;
    const result = await startSetupServer(harness.deps, {
      scheduleTimeout(callback, delay) {
        if (delay === 10 * 60 * 1_000) {
          expire = callback;
        }
        return callback;
      },
      cancelTimeout() {},
    });
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const responseText = apiRequest(baseUrl, "/api/config", key)
      .then((response) => response.text())
      .catch(() => "REQUEST_ABORTED");
    await readStarted.promise;

    now += 10 * 60 * 1_000 + 1;
    expire?.();
    await expect(Promise.race([
      result.closed.then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])).resolves.toBe("closed");
    readGate.resolve(savedRecord);

    expect(await responseText).not.toContain(savedRecord.refreshToken);
  });

  it("expires during provider validation without mutating or echoing the candidate", async () => {
    const validationStarted = deferred();
    const validationGate = deferred<CredentialRecord>();
    const harness = await createHarness({
      record: savedRecord,
      validate: async () => {
        validationStarted.resolve();
        return validationGate.promise;
      },
    });
    cleanups.push(harness.cleanup);
    let now = 20_000;
    let expire: (() => void) | undefined;
    harness.deps.clock = () => now;
    const result = await startSetupServer(harness.deps, {
      scheduleTimeout(callback, delay) {
        if (delay === 10 * 60 * 1_000) {
          expire = callback;
        }
        return callback;
      },
      cancelTimeout() {},
    });
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const candidateRefreshToken = "expiry-candidate-refresh-CANARY";
    const responseText = apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorizationPageUrl: "http://expiry-auth.example.test/custom",
        refreshApiUrl: "http://expiry-refresh.example.test/custom/renew",
        refreshToken: candidateRefreshToken,
      }),
    }).then((response) => response.text()).catch(() => "REQUEST_ABORTED");
    await validationStarted.promise;

    now += 10 * 60 * 1_000 + 1;
    expire?.();
    validationGate.resolve({ ...savedRecord, refreshToken: candidateRefreshToken });
    await result.closed;

    expect(harness.replaceIfVersion).not.toHaveBeenCalled();
    expect(harness.record).toEqual(savedRecord);
    expect(await responseText).not.toContain(candidateRefreshToken);
  });

  it("aborts the real OpenList validation request on setup expiry before drive discovery", async () => {
    const api = await startDelayedApi("/custom/renew");
    cleanups.push(api.close);
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    harness.deps.provider = new AliyunProvider({
      tokenService: new OpenListTokenService(),
      baseUrl: api.baseUrl,
      tokenManager: { async forceRefresh() { return "unused"; } },
    });
    let expire: (() => void) | undefined;
    const result = await startSetupServer(harness.deps, {
      scheduleTimeout(callback, delay) {
        if (delay === 10 * 60 * 1_000) expire = callback;
        return callback;
      },
      cancelTimeout() {},
    });
    runningServers.push(result);
    const saving = apiRequest(
      result.url.split("/#")[0] ?? "",
      "/api/config",
      accessKey(result.url),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorizationPageUrl: "http://auth.example.test/custom",
          refreshApiUrl: `${api.baseUrl}/custom/renew`,
          refreshToken: "openlist-refresh",
        }),
      },
    ).catch(() => undefined);
    await api.started;

    expire?.();

    await expect(Promise.race([
      api.aborted.then(() => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])).resolves.toBe("aborted");
    await result.closed;
    await saving;
    expect(api.requests).toEqual(["/custom/renew"]);
    expect(harness.replaceIfVersion).not.toHaveBeenCalled();
  });

  it("aborts the real test-upload provider request on expiry before directory or upload mutation", async () => {
    const api = await startDelayedApi("/adrive/v1.0/user/getDriveInfo");
    cleanups.push(api.close);
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const provider = new AliyunProvider({
      tokenService: { async refresh() { throw new Error("unused"); } },
      baseUrl: api.baseUrl,
      tokenManager: { async forceRefresh() { return savedRecord.accessToken; } },
    });
    harness.deps.orchestrator = new UploadOrchestrator({
      providerRegistry: { resolve: () => provider },
      tokenManager: { async getValidAccessToken() { return savedRecord.accessToken; } },
      config: { defaultDirectory: "/openClawShare" },
    });
    let expire: (() => void) | undefined;
    const result = await startSetupServer(harness.deps, {
      scheduleTimeout(callback, delay) {
        if (delay === 10 * 60 * 1_000) expire = callback;
        return callback;
      },
      cancelTimeout() {},
    });
    runningServers.push(result);
    const uploading = apiRequest(
      result.url.split("/#")[0] ?? "",
      "/api/test-upload",
      accessKey(result.url),
      { method: "POST" },
    ).catch(() => undefined);
    await api.started;

    expire?.();

    await expect(Promise.race([
      api.aborted.then(() => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])).resolves.toBe("aborted");
    await result.closed;
    await uploading;
    expect(api.requests).toEqual(["/adrive/v1.0/user/getDriveInfo"]);
  });

  it("passes expiry cancellation into a delayed Vault CAS so it cannot commit", async () => {
    const casStarted = deferred();
    const casGate = deferred();
    let committed = false;
    const harness = await createHarness({
      record: savedRecord,
      replaceIfVersion: async (_expected, _candidate, mutationOptions) => {
        casStarted.resolve();
        await casGate.promise;
        if (mutationOptions?.signal?.aborted === true) {
          return false;
        }
        committed = true;
        return true;
      },
    });
    cleanups.push(harness.cleanup);
    let now = 30_000;
    let expire: (() => void) | undefined;
    harness.deps.clock = () => now;
    const result = await startSetupServer(harness.deps, {
      scheduleTimeout(callback, delay) {
        if (delay === 10 * 60 * 1_000) {
          expire = callback;
        }
        return callback;
      },
      cancelTimeout() {},
    });
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const save = apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorizationPageUrl: "http://cas-auth.example.test/custom",
        refreshApiUrl: "http://cas-refresh.example.test/custom/renew",
        refreshToken: "cas-refresh",
      }),
    }).catch(() => undefined);
    await casStarted.promise;

    now += 10 * 60 * 1_000 + 1;
    expire?.();
    casGate.resolve();
    await result.closed;
    await save;

    expect(committed).toBe(false);
    expect(harness.record).toEqual(savedRecord);
  });

  it("requires exact clear confirmation and rejects streaming bodies over 64 KiB", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    for (const confirm of ["clear", " CLEAR ", "CLEAR\n", undefined]) {
      const response = await apiRequest(baseUrl, "/api/config", key, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
      expect(response.status).toBe(400);
    }
    expect(harness.clear).not.toHaveBeenCalled();

    const oversized = await apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(harness.validateCredentials).not.toHaveBeenCalled();

    const cleared = await apiRequest(baseUrl, "/api/config", key, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "CLEAR" }),
    });
    expect(cleared.status).toBe(200);
    expect(harness.clear).toHaveBeenCalledTimes(1);
    expect(harness.clear).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.record).toBeUndefined();
  });

  it("rejects oversized bodies before bodyless POST actions execute", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    for (const route of ["/api/revalidate", "/api/test-upload"]) {
      const response = await apiRequest(baseUrl, route, key, {
        method: "POST",
        body: "x".repeat(64 * 1024 + 1),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(harness.validateCredentials).not.toHaveBeenCalled();
    expect(harness.upload).not.toHaveBeenCalled();
  });

  it("enforces the 64 KiB cap on a real chunked body before static and unknown routing", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const target = new URL(result.url.split("/#")[0] ?? "");

    for (const requestTarget of ["/", "/unknown"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = nodeRequest({
          hostname: target.hostname,
          port: target.port,
          path: requestTarget,
          method: requestTarget === "/" ? "GET" : "PATCH",
          headers: {
            host: `127.0.0.1:${result.port}`,
            "transfer-encoding": "chunked",
          },
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        request.once("error", reject);
        request.write(Buffer.alloc(40 * 1024, 0x61));
        request.end(Buffer.alloc(30 * 1024, 0x62));
      });
      expect(status).toBe(413);
    }

    const rejectedHostStatus = await new Promise<number>((resolve, reject) => {
      const request = nodeRequest({
        hostname: target.hostname,
        port: target.port,
        path: "/",
        method: "PATCH",
        headers: {
          host: `localhost:${result.port}`,
          "content-length": 64 * 1024 + 1,
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.end();
    });
    expect(rejectedHostStatus).toBe(413);
  });

  it("requires JSON media type for JSON routes and empty bodies for POST actions", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const body = JSON.stringify({
      authorizationPageUrl: "http://media-auth.example.test/custom",
      refreshApiUrl: "http://media-refresh.example.test/custom/renew",
      refreshToken: "media-refresh",
    });

    const wrong = await apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body,
    });
    const missing = await apiRequest(baseUrl, "/api/config", key, {
      method: "PUT",
      body,
    });
    const nonemptyPost = await apiRequest(baseUrl, "/api/revalidate", key, {
      method: "POST",
      body: "{}",
    });

    expect([wrong.status, missing.status]).toEqual([415, 415]);
    expect(nonemptyPost.status).toBe(400);
    expect(harness.validateCredentials).not.toHaveBeenCalled();
  });

  it("settles a slow chunked body at the owned request deadline", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    let deadline: (() => void) | undefined;
    const result = await startSetupServer(harness.deps, {
      scheduleRequestTimeout(callback, delay) {
        expect(delay).toBeGreaterThan(0);
        deadline = callback;
        return callback;
      },
      cancelRequestTimeout() {},
    });
    runningServers.push(result);
    const target = new URL(result.url.split("/#")[0] ?? "");
    const settled = new Promise<number>((resolve) => {
      const request = nodeRequest({
        hostname: target.hostname,
        port: target.port,
        path: "/api/config",
        method: "PUT",
        headers: {
          host: `127.0.0.1:${result.port}`,
          authorization: `PanSyncSetup ${accessKey(result.url)}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", () => resolve(0));
      request.write("{\"authorizationPageUrl\":");
    });
    await vi.waitFor(() => expect(deadline).toBeTypeOf("function"));

    deadline?.();

    await expect(Promise.race([
      settled,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 500)),
    ])).resolves.toBe(408);
  });

  it("revalidates saved credentials and test-uploads through the normal orchestrator with cleanup", async () => {
    let uploadWorkspace = "";
    let uploadPayload = "";
    let uploadMode = 0;
    let uploadPaths: string[] = [];
    const harness = await createHarness({
      record: savedRecord,
      upload: async (input) => {
        uploadWorkspace = input.workspaceDir;
        uploadPaths = input.paths;
        const payloadPath = path.join(input.workspaceDir, "payload.txt");
        uploadPayload = await readFile(payloadPath, "utf8");
        uploadMode = (await stat(payloadPath)).mode & 0o777;
        return {
          provider: "aliyun" as const,
          remoteDirectory: "/openClawShare",
          status: "success" as const,
          files: [{
            inputName: "payload.txt",
            remoteName: "setup-test (1).txt",
            size: Buffer.byteLength(uploadPayload),
            status: "uploaded" as const,
          }],
        };
      },
    });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    const revalidated = await apiRequest(baseUrl, "/api/revalidate", key, {
      method: "POST",
    });
    expect(revalidated.status).toBe(200);
    expect(harness.validateCredentials).toHaveBeenCalledWith({
      authorizationPageUrl: savedRecord.authorizationPageUrl,
      refreshApiUrl: savedRecord.refreshApiUrl,
      refreshToken: savedRecord.refreshToken,
      credentialVersion: 8,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const uploaded = await apiRequest(baseUrl, "/api/test-upload", key, {
      method: "POST",
    });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({
      remoteName: "setup-test (1).txt",
      remoteDirectory: "/openClawShare",
    });
    expect(path.dirname(uploadWorkspace)).toBe(path.join(harness.deps.dataDir, "tmp"));
    expect(path.basename(uploadWorkspace)).toMatch(/^pan-sync-test-/u);
    expect(uploadPaths).toEqual(["payload.txt"]);
    expect(uploadPayload).toMatch(/^[A-Za-z0-9_-]{43}\n$/u);
    if (process.platform !== "win32") {
      expect(uploadMode).toBe(0o600);
    }
    const uploadInput = harness.upload.mock.calls[0]?.[0];
    expect(uploadInput).toMatchObject({
      remoteDirectory: "/openClawShare",
      workspaceDir: uploadWorkspace,
      paths: ["payload.txt"],
    });
    await expect(access(uploadWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked temporary root without writing outside dataDir", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const outside = await mkdtemp(path.join(tmpdir(), "pan-sync-admin-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await mkdir(harness.deps.dataDir, { recursive: true });
    await symlink(outside, path.join(harness.deps.dataDir, "tmp"), "junction");
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";

    const response = await apiRequest(baseUrl, "/api/test-upload", accessKey(result.url), { method: "POST" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "UPLOAD_FAILED" });
    expect(await readdir(outside)).toEqual([]);
    expect(harness.upload).not.toHaveBeenCalled();
  });

  it("does not report test-upload success when private workspace cleanup fails", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    let workspace = "";
    const result = await startSetupServer(harness.deps, {
      async removeTemporaryDirectory(directory) {
        workspace = directory;
        throw new Error("cleanup failed");
      },
    });
    runningServers.push(result);
    const response = await apiRequest(
      result.url.split("/#")[0] ?? "",
      "/api/test-upload",
      accessKey(result.url),
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "UPLOAD_FAILED" });
    expect(workspace).toMatch(/pan-sync-test-/u);
  });

  it("removes a newly created private workspace when its chmod fails", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    let workspace = "";
    const runtime = {
      temporaryFiles: {
        async chmod(target: string, mode: number) {
          if (path.basename(target).startsWith("pan-sync-test-")) {
            workspace = target;
            throw new Error("workspace chmod failed");
          }
          await chmod(target, mode);
        },
      },
    } as unknown as SetupServerRuntime;
    const result = await startSetupServer(harness.deps, runtime);
    runningServers.push(result);

    const response = await apiRequest(
      result.url.split("/#")[0] ?? "",
      "/api/test-upload",
      accessKey(result.url),
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "UPLOAD_FAILED" });
    expect(workspace).toMatch(/pan-sync-test-/u);
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function executePage(
  url: string,
  storedKey?: string,
): Promise<{
  dom: JSDOM;
  requests: Array<{ url: string; init?: RequestInit }>;
  errors: unknown[][];
}> {
  const html = await readFile(path.resolve("ui/setup.html"), "utf8");
  const script = await readFile(path.resolve("ui/setup.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url });
  if (storedKey !== undefined) {
    dom.window.sessionStorage.setItem("panSyncSetupAccessKey", storedKey);
  }
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const errors: unknown[][] = [];
  dom.window.console.error = (...values: unknown[]) => errors.push(values);
  dom.window.console.log = (...values: unknown[]) => errors.push(values);
  dom.window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(input);
    requests.push(init === undefined ? { url: requestUrl } : { url: requestUrl, init });
    const body = init?.method === "DELETE"
      ? { configured: false }
      : {
        configured: true,
        credentials: {
          authorizationPageUrl: "http://browser-auth.example.test/custom",
          refreshApiUrl: "http://browser-refresh.example.test/custom/renew",
          refreshToken: "browser-refresh",
        },
        defaultDirectory: "/openClawShare",
      };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof dom.window.fetch;
  dom.window.eval(script);
  await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
  return { dom, requests, errors };
}

describe("setup page browser behavior", () => {
  it("strips the fragment and preserves only the session key across same-tab reload", async () => {
    const key = "A".repeat(43);
    const first = await executePage(`http://127.0.0.1:43123/#${key}`);
    expect(first.dom.window.location.hash).toBe("");
    expect(first.requests[0]?.url).toBe("/api/config");
    expect(new Headers(first.requests[0]?.init?.headers).get("authorization")).toBe(`PanSyncSetup ${key}`);
    expect(first.requests[0]?.url).not.toContain(key);
    await vi.waitFor(() => {
      expect(first.dom.window.document.getElementById("result")?.textContent).toBe("READY");
    });
    first.dom.window.dispatchEvent(new first.dom.window.Event("pagehide"));
    const storedKeyAfterPagehide = first.dom.window.sessionStorage.getItem("panSyncSetupAccessKey");
    expect(storedKeyAfterPagehide).toBe(key);
    expect(first.dom.window.localStorage.length).toBe(0);
    for (const id of ["authorizationPageUrl", "refreshApiUrl", "refreshToken"]) {
      expect((first.dom.window.document.getElementById(id) as HTMLInputElement).value).toBe("");
    }
    const requestCountAfterPagehide = first.requests.length;
    (first.dom.window.document.getElementById("revalidate") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.requests).toHaveLength(requestCountAfterPagehide);

    if (storedKeyAfterPagehide === null) {
      throw new Error("same-tab reload key was not preserved");
    }
    const reload = await executePage("http://127.0.0.1:43123/", storedKeyAfterPagehide);
    expect(new Headers(reload.requests[0]?.init?.headers).get("authorization")).toBe(`PanSyncSetup ${key}`);
    expect(reload.dom.window.localStorage.length).toBe(0);
  });

  it("uses visible text inputs, clears values on pagehide, and never renders or logs raw errors", async () => {
    const key = "B".repeat(43);
    const page = await executePage(`http://127.0.0.1:43123/#${key}`);
    await vi.waitFor(() => {
      expect(page.dom.window.document.getElementById("result")?.textContent).toBe("READY");
    });
    for (const id of ["authorizationPageUrl", "refreshApiUrl", "refreshToken"]) {
      const input = page.dom.window.document.getElementById(id) as HTMLInputElement;
      expect(input.type).toBe("text");
    }
    expect((page.dom.window.document.getElementById("refreshToken") as HTMLInputElement).autocomplete).toBe("off");
    expect(page.dom.window.document.getElementById("clientId")).toBeNull();
    expect(page.dom.window.document.getElementById("clientSecret")).toBeNull();
    expect(page.dom.window.document.getElementById("accessToken")).toBeNull();
    const authorizationInput = page.dom.window.document.getElementById("authorizationPageUrl") as HTMLInputElement;
    const authorizationLink = page.dom.window.document.getElementById("openAuthorizationPage") as HTMLAnchorElement;
    expect(authorizationLink.href).toBe("http://browser-auth.example.test/custom");
    authorizationInput.value = "http://changed-auth.example.test/custom";
    authorizationInput.dispatchEvent(new page.dom.window.Event("input"));
    expect(authorizationLink.href).toBe("http://changed-auth.example.test/custom");

    expect(page.dom.window.document.body.textContent).toContain(
      "The refresh token is sent to the configured refresh API URL",
    );
    expect(page.dom.window.document.body.textContent).toMatch(
      /HTTP.*self-hosted.*third-party.*risk.*user/isu,
    );
    const form = page.dom.window.document.getElementById("credentials") as HTMLFormElement;
    form.dispatchEvent(new page.dom.window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(page.requests.some(({ init }) => init?.method === "PUT")).toBe(true));
    const save = page.requests.find(({ init }) => init?.method === "PUT");
    expect(JSON.parse(String(save?.init?.body))).toEqual({
      authorizationPageUrl: "http://changed-auth.example.test/custom",
      refreshApiUrl: "http://browser-refresh.example.test/custom/renew",
      refreshToken: "browser-refresh",
    });
    const canary = "raw-native-error-client-secret-CANARY";
    page.dom.window.fetch = (async () => {
      throw new Error(canary);
    }) as typeof page.dom.window.fetch;
    (page.dom.window.document.getElementById("revalidate") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(page.dom.window.document.getElementById("result")?.textContent).toBe("REQUEST_FAILED");
    });
    expect(page.dom.window.document.body.textContent).not.toContain(canary);
    expect(JSON.stringify(page.errors)).not.toContain(canary);

    page.dom.window.dispatchEvent(new page.dom.window.Event("pagehide"));
    for (const id of ["authorizationPageUrl", "refreshApiUrl", "refreshToken"]) {
      expect((page.dom.window.document.getElementById(id) as HTMLInputElement).value).toBe("");
    }
  });

  it("strips the fragment before guarded session storage access", async () => {
    const html = await readFile(path.resolve("ui/setup.html"), "utf8");
    const script = await readFile(path.resolve("ui/setup.js"), "utf8");
    const key = "D".repeat(43);
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: `http://127.0.0.1:43123/#${key}`,
    });
    Object.defineProperty(dom.window, "sessionStorage", {
      configurable: true,
      get() {
        expect(dom.window.location.hash).toBe("");
        throw new Error("storage disabled");
      },
    });
    const requests: RequestInit[] = [];
    dom.window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ configured: false }), { status: 200 });
    }) as typeof dom.window.fetch;

    expect(() => dom.window.eval(script)).not.toThrow();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(new Headers(requests[0]?.headers).get("authorization")).toBe(`PanSyncSetup ${key}`);
  });

  it("ignores an older config response after a newer revalidation starts", async () => {
    const html = await readFile(path.resolve("ui/setup.html"), "utf8");
    const script = await readFile(path.resolve("ui/setup.js"), "utf8");
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: `http://127.0.0.1:43123/#${"E".repeat(43)}`,
    });
    const responses = [deferred<Response>(), deferred<Response>()];
    let call = 0;
    dom.window.fetch = vi.fn(async () => responses[call++]?.promise) as typeof dom.window.fetch;
    dom.window.eval(script);
    await vi.waitFor(() => expect(call).toBe(1));
    (dom.window.document.getElementById("revalidate") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(call).toBe(2));
    responses[1]?.resolve(new Response(JSON.stringify({
      configured: true,
      credentials: {
        authorizationPageUrl: "http://new-auth.example.test/custom",
        refreshApiUrl: "http://new-refresh.example.test/custom/renew",
        refreshToken: "new-refresh",
      },
    }), { status: 200 }));
    await vi.waitFor(() => expect((dom.window.document.getElementById("authorizationPageUrl") as HTMLInputElement).value).toBe("http://new-auth.example.test/custom"));
    responses[0]?.resolve(new Response(JSON.stringify({
      configured: true,
      credentials: {
        authorizationPageUrl: "http://stale-auth.example.test/custom",
        refreshApiUrl: "http://stale-refresh.example.test/custom/renew",
        refreshToken: "stale-refresh",
      },
    }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((dom.window.document.getElementById("authorizationPageUrl") as HTMLInputElement).value).toBe("http://new-auth.example.test/custom");
  });

  it("aborts and ignores pending work on pagehide while clearing form values", async () => {
    const html = await readFile(path.resolve("ui/setup.html"), "utf8");
    const script = await readFile(path.resolve("ui/setup.js"), "utf8");
    const key = "F".repeat(43);
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: `http://127.0.0.1:43123/#${key}`,
    });
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    dom.window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return pending.promise;
    }) as typeof dom.window.fetch;
    dom.window.eval(script);
    await vi.waitFor(() => expect(signal).toBeDefined());
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));

    expect(signal?.aborted).toBe(true);
    pending.resolve(new Response(JSON.stringify({
      configured: true,
      credentials: {
        authorizationPageUrl: "http://late-auth.example.test/custom",
        refreshApiUrl: "http://late-refresh.example.test/custom/renew",
        refreshToken: "late-refresh",
      },
    }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const id of ["authorizationPageUrl", "refreshApiUrl", "refreshToken"]) {
      expect((dom.window.document.getElementById(id) as HTMLInputElement).value).toBe("");
    }
  });

  it("requires a distinct second Clear confirmation before sending DELETE", async () => {
    const page = await executePage(`http://127.0.0.1:43123/#${"C".repeat(43)}`);
    const initialCount = page.requests.length;
    (page.dom.window.document.getElementById("clearCredentials") as HTMLButtonElement).click();
    expect(page.requests).toHaveLength(initialCount);
    expect((page.dom.window.document.getElementById("confirmClear") as HTMLElement).hidden).toBe(false);

    (page.dom.window.document.getElementById("confirmClear") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(page.requests.some(({ init }) => init?.method === "DELETE")).toBe(true);
    });
    const deletion = page.requests.find(({ init }) => init?.method === "DELETE");
    expect(deletion?.url).toBe("/api/config");
    expect(deletion?.init?.body).toBe(JSON.stringify({ confirm: "CLEAR" }));
  });
});
