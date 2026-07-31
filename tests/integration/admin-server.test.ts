import {
  createServer as nodeCreateServer,
  request as nodeRequest,
  type Server,
} from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { PanSyncError } from "../../src/errors.js";
import {
  startSetupServer,
  type SetupServerDependencies,
} from "../../src/admin/setup-server.js";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
} as const;

const savedRecord: CredentialRecord = {
  formatVersion: 1,
  credentialVersion: 7,
  clientId: "client-id-saved",
  clientSecret: "client-secret-saved",
  refreshToken: "refresh-token-saved",
  accessToken: "access-token-saved",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  account: {
    userIdMasked: "use***42",
    displayNameMasked: "A***",
  },
  lastVerifiedAt: "2026-07-31T00:00:00.000Z",
};

type HarnessOptions = {
  record?: CredentialRecord | undefined;
  validate?: SetupServerDependencies["provider"]["validateCredentials"];
  upload?: SetupServerDependencies["orchestrator"]["upload"];
  replaceIfVersion?: (expected: number, candidate: CredentialRecord) => Promise<boolean>;
};

async function createHarness(options: HarnessOptions = {}) {
  let record = options.record;
  const replace = vi.fn(async (candidate: CredentialRecord) => {
    record = structuredClone(candidate);
  });
  const replaceIfVersion = vi.fn(
    options.replaceIfVersion
      ?? (async (expected: number, candidate: CredentialRecord) => {
        if (record?.credentialVersion !== expected) {
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
        clientId: candidate.clientId,
        clientSecret: candidate.clientSecret,
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
    store: { read, replace, replaceIfVersion, clear },
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
    expect(await responses[0]?.text()).not.toContain(savedRecord.clientSecret);

    const rejectedHost = await requestWithHost(baseUrl, "/api/config", "attacker.example");
    expect(rejectedHost.status).toBe(400);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(rejectedHost.headers[name]).toBe(value);
    }
    expect(rejectedHost.body).not.toContain(savedRecord.clientSecret);
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
      expect(await response.text()).not.toContain(savedRecord.clientSecret);
    }

    const response = await apiRequest(baseUrl, "/api/config", key);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      credentials: {
        clientId: savedRecord.clientId,
        clientSecret: savedRecord.clientSecret,
        refreshToken: savedRecord.refreshToken,
      },
    });
  });

  it("projects configured page guidance only after authorization", async () => {
    const harness = await createHarness({ record: savedRecord });
    harness.deps.defaultDirectory = "/teamShare";
    harness.deps.tokenGuideUrl = "https://docs.example.test/aliyun-token";
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);

    const publicPage = await apiRequest(baseUrl, "/");
    expect(await publicPage.text()).not.toContain("docs.example.test");
    const config = await apiRequest(baseUrl, "/api/config", key);
    expect(await config.json()).toMatchObject({
      defaultDirectory: "/teamShare",
      tokenGuideUrl: "https://docs.example.test/aliyun-token",
    });
  });

  it("validates a candidate before atomically replacing the saved record", async () => {
    const harness = await createHarness({ record: savedRecord });
    cleanups.push(harness.cleanup);
    const result = await startSetupServer(harness.deps);
    runningServers.push(result);
    const baseUrl = result.url.split("/#")[0] ?? "";
    const key = accessKey(result.url);
    const candidate = {
      clientId: "candidate-client",
      clientSecret: "candidate-secret",
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
    });
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.replaceIfVersion).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ credentialVersion: 8 }),
    );
    expect(harness.record).toMatchObject({
      credentialVersion: 8,
      clientId: candidate.clientId,
      clientSecret: candidate.clientSecret,
      refreshToken: "candidate-refresh-rotated",
    });
    expect(await response.json()).toMatchObject({
      credentials: {
        clientSecret: candidate.clientSecret,
        refreshToken: "candidate-refresh-rotated",
      },
    });
  });

  it("does not overwrite a newer record when the shared lease version check loses a race", async () => {
    const winner = { ...savedRecord, credentialVersion: 8, clientId: "concurrent-winner" };
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
        clientId: "stale-client",
        clientSecret: "stale-secret",
        refreshToken: "stale-refresh",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CREDENTIALS_INVALID" });
    expect(harness.record).toEqual(winner);
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
        clientId: "candidate-client",
        clientSecret: "wrong-secret",
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

  it("revalidates saved credentials and test-uploads through the normal orchestrator with cleanup", async () => {
    const harness = await createHarness({ record: savedRecord });
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
      clientId: savedRecord.clientId,
      clientSecret: savedRecord.clientSecret,
      refreshToken: savedRecord.refreshToken,
      credentialVersion: 8,
    });

    const uploaded = await apiRequest(baseUrl, "/api/test-upload", key, {
      method: "POST",
    });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({
      remoteName: "setup-test (1).txt",
      remoteDirectory: "/openClawShare",
    });
    const uploadInput = harness.upload.mock.calls[0]?.[0];
    expect(uploadInput).toMatchObject({
      remoteDirectory: "/openClawShare",
      workspaceDir: path.join(harness.deps.dataDir, "tmp"),
    });
    const localName = uploadInput?.paths[0];
    expect(localName).toMatch(/^pan-sync-test-[0-9a-f]+\.txt$/);
    await expect(access(path.join(uploadInput?.workspaceDir ?? "", localName ?? ""))).rejects.toMatchObject({ code: "ENOENT" });
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
          clientId: "browser-client",
          clientSecret: "browser-secret",
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
  it("strips the fragment before its first authenticated request and restores only the key on reload", async () => {
    const key = "A".repeat(43);
    const first = await executePage(`http://127.0.0.1:43123/#${key}`);
    expect(first.dom.window.location.hash).toBe("");
    expect(first.requests[0]?.url).toBe("/api/config");
    expect(new Headers(first.requests[0]?.init?.headers).get("authorization")).toBe(`PanSyncSetup ${key}`);
    expect(first.requests[0]?.url).not.toContain(key);
    expect(first.dom.window.sessionStorage.getItem("panSyncSetupAccessKey")).toBe(key);
    expect(first.dom.window.localStorage.length).toBe(0);

    const reload = await executePage("http://127.0.0.1:43123/", key);
    expect(new Headers(reload.requests[0]?.init?.headers).get("authorization")).toBe(`PanSyncSetup ${key}`);
    expect(reload.dom.window.localStorage.length).toBe(0);
  });

  it("uses visible text inputs, clears values on pagehide, and never renders or logs raw errors", async () => {
    const key = "B".repeat(43);
    const page = await executePage(`http://127.0.0.1:43123/#${key}`);
    await vi.waitFor(() => {
      expect(page.dom.window.document.getElementById("result")?.textContent).toBe("READY");
    });
    for (const id of ["clientId", "clientSecret", "refreshToken"]) {
      const input = page.dom.window.document.getElementById(id) as HTMLInputElement;
      expect(input.type).toBe("text");
      expect(input.autocomplete).toBe("off");
    }
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
    for (const id of ["clientId", "clientSecret", "refreshToken"]) {
      expect((page.dom.window.document.getElementById(id) as HTMLInputElement).value).toBe("");
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
