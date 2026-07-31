import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TokenManager,
  type TokenCredentialVault,
} from "../../src/credentials/token-manager.js";
import {
  CredentialStore,
  type CredentialLeaseRunner,
} from "../../src/credentials/store.js";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { PanSyncError } from "../../src/errors.js";
import { AliyunHttpClient } from "../../src/providers/aliyun/http.js";
import {
  startFakeAliyunServer,
  type FakeAliyunResponse,
  type FakeAliyunServer,
} from "../helpers/fake-aliyun-server.js";
import { createTempState } from "../helpers/temp-state.js";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const immediateLease: CredentialLeaseRunner = (_key, run) => run({
  assertOwned: async () => undefined,
});
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function expiredRecord(
  credentialVersion = 1,
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  return {
    formatVersion: 1,
    credentialVersion,
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: `refresh-${credentialVersion}`,
    accessToken: `access-${credentialVersion}`,
    accessTokenExpiresAt: new Date(NOW - 1).toISOString(),
    account: {
      userIdMasked: "user-***",
      displayNameMasked: "name-***",
    },
    lastVerifiedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

async function tempStore(): Promise<{
  dataDir: string;
  store: CredentialStore;
}> {
  const state = await createTempState();
  cleanups.push(state.cleanup);
  return {
    dataDir: state.dataDir,
    store: new CredentialStore(state.dataDir, immediateLease),
  };
}

async function fakeServer(
  response: FakeAliyunResponse | FakeAliyunResponse[],
): Promise<FakeAliyunServer> {
  const server = await startFakeAliyunServer(response);
  cleanups.push(server.close);
  return server;
}

async function refusedLocalBaseUrl(): Promise<string> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", reject);
      resolve();
    });
  });
  const address = listener.address();
  if (address === null || typeof address === "string") {
    throw new Error("refused-endpoint fixture did not bind a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return `http://127.0.0.1:${address.port}`;
}

type PromiseOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

async function outcomeWithin<T>(
  promise: Promise<T>,
  timeoutMs = 500,
): Promise<PromiseOutcome<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<PromiseOutcome<T>, PromiseOutcome<T>>(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
      new Promise<PromiseOutcome<T>>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function flushTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function memoryVault(initial: CredentialRecord): {
  vault: TokenCredentialVault;
  current(): CredentialRecord;
} {
  let record = initial;
  return {
    vault: {
      async read() {
        return record;
      },
      async replaceIfVersion(expected, candidate, options) {
        if (options?.signal?.aborted === true) {
          throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
        }
        if (record.credentialVersion !== expected) {
          return false;
        }
        record = candidate;
        return true;
      },
    },
    current: () => record,
  };
}

function controlledRefresh(): {
  aliyun: Pick<AliyunHttpClient, "refreshToken">;
  started: Promise<void>;
  calls(): number;
  upstreamSignal(): AbortSignal | undefined;
  succeed(result?: Awaited<ReturnType<AliyunHttpClient["refreshToken"]>>): void;
  fail(error: unknown): void;
} {
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveResult: (
    result: Awaited<ReturnType<AliyunHttpClient["refreshToken"]>>,
  ) => void = () => undefined;
  let rejectResult: (error: unknown) => void = () => undefined;
  const result = new Promise<
    Awaited<ReturnType<AliyunHttpClient["refreshToken"]>>
  >((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let callCount = 0;
  let capturedSignal: AbortSignal | undefined;

  return {
    aliyun: {
      async refreshToken(input) {
        callCount += 1;
        capturedSignal = input.signal;
        const rejectForAbort = () => {
          rejectResult(new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE"));
        };
        if (input.signal?.aborted === true) {
          rejectForAbort();
        } else {
          input.signal?.addEventListener("abort", rejectForAbort, { once: true });
        }
        resolveStarted?.();
        try {
          return await result;
        } finally {
          input.signal?.removeEventListener("abort", rejectForAbort);
        }
      },
    },
    started,
    calls: () => callCount,
    upstreamSignal: () => capturedSignal,
    succeed: (value = {
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresInSeconds: 7_200,
    }) => resolveResult(value),
    fail: rejectResult,
  };
}

async function hangingTokenServer(): Promise<{
  baseUrl: string;
  requestReceived: Promise<void>;
  upstreamSocketClosed: Promise<void>;
  activeSockets(): number;
  close(): Promise<void>;
}> {
  let resolveRequest: (() => void) | undefined;
  const requestReceived = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  let resolveSocketClosed: (() => void) | undefined;
  const upstreamSocketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const sockets = new Set<Socket>();
  let requestWasReceived = false;
  const server = createHttpServer((request) => {
    request.resume();
    request.once("end", () => {
      requestWasReceived = true;
      resolveRequest?.();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      if (requestWasReceived) {
        resolveSocketClosed?.();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("hanging token server did not bind a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestReceived,
    upstreamSocketClosed,
    activeSockets: () => sockets.size,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function successResponse(
  accessToken = "access-2",
  refreshToken = "refresh-2",
): FakeAliyunResponse {
  return {
    status: 200,
    body: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 7_200,
    },
  };
}

function client(server: FakeAliyunServer): AliyunHttpClient {
  return new AliyunHttpClient({
    baseUrl: server.baseUrl,
    clock: () => NOW,
  });
}

async function rejectedPanSyncError(
  run: () => Promise<unknown>,
): Promise<PanSyncError> {
  let rejected: unknown;
  try {
    await run();
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(PanSyncError);
  return rejected as PanSyncError;
}

describe("AliyunHttpClient", () => {
  it("posts the official refresh-token payload and returns rotated tokens", async () => {
    const server = await fakeServer(successResponse());
    const aliyun = client(server);

    const result = await aliyun.refreshToken({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-1",
    });

    expect(server.requests).toHaveLength(1);
    const recorded = server.requests[0];
    expect(recorded).toMatchObject({
      method: "POST",
      path: "/oauth/access_token",
    });
    expect(recorded?.body).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    });
    expect(result).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresInSeconds: 7_200,
    });
  });

  it.each([
    {
      name: "invalid_grant",
      response: {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "refresh-1 client-secret response-CANARY",
        },
      },
      code: "REFRESH_TOKEN_REJECTED",
    },
    {
      name: "HTTP 429",
      response: {
        status: 429,
        body: { message: "refresh-1 response-CANARY" },
      },
      code: "RATE_LIMITED",
    },
    {
      name: "HTTP 502",
      response: {
        status: 502,
        body: { message: "refresh-1 response-CANARY" },
      },
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
    },
    {
      name: "HTTP 503",
      response: {
        status: 503,
        body: { message: "refresh-1 response-CANARY" },
      },
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
    },
  ] as const)(
    "maps $name without exposing request or response bodies",
    async ({ response, code }) => {
      const server = await fakeServer(response);

      const error = await rejectedPanSyncError(() =>
        client(server).refreshToken({
          clientId: "client-id",
          clientSecret: "client-secret",
          refreshToken: "refresh-1",
        }),
      );

      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
      expect(error.message).not.toContain("refresh-1");
      expect(error.message).not.toContain("client-secret");
      expect(error.message).not.toContain("response-CANARY");
    },
  );

  it.each([
    {
      status: 429,
      code: "RATE_LIMITED",
    },
    {
      status: 502,
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
    },
    {
      status: 503,
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
    },
  ] as const)(
    "prioritizes HTTP $status over an invalid_grant response body",
    async ({ status, code }) => {
      const server = await fakeServer({
        status,
        body: {
          error: "invalid_grant",
          error_description: "mixed-status-response-CANARY",
        },
      });

      const error = await rejectedPanSyncError(() =>
        client(server).refreshToken({
          clientId: "client-id",
          clientSecret: "mixed-status-secret-CANARY",
          refreshToken: "mixed-status-refresh-CANARY",
        }),
      );

      expect(error.code).toBe(code);
      expect(error.message).not.toContain("mixed-status-secret-CANARY");
      expect(error.message).not.toContain("mixed-status-refresh-CANARY");
      expect(error.message).not.toContain("mixed-status-response-CANARY");
    },
  );

  it("maps the 15-second request timeout without exposing tokens", async () => {
    const server = await fakeServer({ status: 200, hang: true });
    const timeoutDelays: number[] = [];
    const aliyun = new AliyunHttpClient({
      baseUrl: server.baseUrl,
      clock: () => NOW,
      scheduleTimeout(callback, delayMs) {
        timeoutDelays.push(delayMs);
        return setTimeout(callback, 25);
      },
      cancelTimeout: clearTimeout,
    });

    const error = await rejectedPanSyncError(() =>
      aliyun.refreshToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-timeout-CANARY",
      }),
    );

    expect(timeoutDelays).toEqual([15_000]);
    expect(error.code).toBe("TOKEN_ENDPOINT_UNAVAILABLE");
    expect(error.message).not.toContain("refresh-timeout-CANARY");
  });
});

describe("TokenManager", () => {
  it("single-flights 20 expired-token callers and persists rotation by CAS", async () => {
    const { store } = await tempStore();
    await store.replace(expiredRecord());
    const server = await fakeServer(successResponse());
    const manager = new TokenManager(store, client(server), () => NOW);

    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => manager.getValidAccessToken()),
    );

    expect(server.requests).toHaveLength(1);
    expect(tokens).toEqual(Array.from({ length: 20 }, () => "access-2"));
    expect(await store.read()).toEqual({
      ...expiredRecord(),
      credentialVersion: 2,
      refreshToken: "refresh-2",
      accessToken: "access-2",
      accessTokenExpiresAt: new Date(NOW + 7_200_000).toISOString(),
      lastVerifiedAt: new Date(NOW).toISOString(),
    });
  });

  it("re-reads the vault and returns a fresh token without refreshing", async () => {
    const { store } = await tempStore();
    await store.replace(expiredRecord());
    const server = await fakeServer(successResponse());
    const manager = new TokenManager(store, client(server), () => NOW);
    await store.replace(expiredRecord(8, {
      accessToken: "cli-access",
      refreshToken: "cli-refresh",
      accessTokenExpiresAt: new Date(NOW + 300_000).toISOString(),
    }));

    await expect(manager.getValidAccessToken()).resolves.toBe("cli-access");
    expect(server.requests).toEqual([]);
  });

  it("refreshes when remaining lifetime is below five minutes", async () => {
    const { store } = await tempStore();
    await store.replace(expiredRecord(1, {
      accessTokenExpiresAt: new Date(NOW + 299_999).toISOString(),
    }));
    const server = await fakeServer(successResponse());
    const manager = new TokenManager(store, client(server), () => NOW);

    await expect(manager.getValidAccessToken()).resolves.toBe("access-2");
    expect(server.requests).toHaveLength(1);
  });

  it("rejects an aborted signaled joiner promptly without cancelling an unsignaled leader", async () => {
    const initial = expiredRecord();
    const store = memoryVault(initial);
    const refresh = controlledRefresh();
    const manager = new TokenManager(store.vault, refresh.aliyun, () => NOW);
    const leader = manager.getValidAccessToken();
    await refresh.started;
    const joinerController = new AbortController();
    const removeListener = vi.spyOn(
      joinerController.signal,
      "removeEventListener",
    );
    const joiner = manager.getValidAccessToken({
      signal: joinerController.signal,
    });
    await flushTurn();

    joinerController.abort();
    const joinerOutcome = await outcomeWithin(joiner);
    refresh.succeed();

    await expect(leader).resolves.toBe("access-2");
    expect(joinerOutcome).toEqual({
      status: "rejected",
      reason: expect.objectContaining({ code: "TOKEN_ENDPOINT_UNAVAILABLE" }),
    });
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(refresh.upstreamSignal()?.aborted).toBe(false);
    expect(refresh.calls()).toBe(1);
    expect(store.current()).toMatchObject({
      credentialVersion: 2,
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    await expect(manager.status()).resolves.toBe("ready");
  });

  it("rejects an aborted signaled leader promptly without cancelling an ordinary joiner", async () => {
    const initial = expiredRecord();
    const store = memoryVault(initial);
    const refresh = controlledRefresh();
    const manager = new TokenManager(store.vault, refresh.aliyun, () => NOW);
    const leaderController = new AbortController();
    const leader = manager.getValidAccessToken({
      signal: leaderController.signal,
    });
    await refresh.started;
    const joiner = manager.getValidAccessToken();
    await flushTurn();

    leaderController.abort();
    const leaderOutcome = await outcomeWithin(leader);
    const upstreamWasAborted = refresh.upstreamSignal()?.aborted;
    refresh.succeed();
    const joinerOutcome = await outcomeWithin(joiner);

    expect(leaderOutcome).toEqual({
      status: "rejected",
      reason: expect.objectContaining({ code: "TOKEN_ENDPOINT_UNAVAILABLE" }),
    });
    expect(upstreamWasAborted).toBe(false);
    expect(joinerOutcome).toEqual({
      status: "fulfilled",
      value: "access-2",
    });
    expect(refresh.calls()).toBe(1);
    expect(store.current()).toMatchObject({
      credentialVersion: 2,
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    await expect(manager.status()).resolves.toBe("ready");
  });

  it("removes every caller abort listener after a shared refresh settles", async () => {
    const store = memoryVault(expiredRecord());
    const refresh = controlledRefresh();
    const manager = new TokenManager(store.vault, refresh.aliyun, () => NOW);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstAdded = vi.spyOn(firstController.signal, "addEventListener");
    const firstRemoved = vi.spyOn(firstController.signal, "removeEventListener");
    const secondAdded = vi.spyOn(secondController.signal, "addEventListener");
    const secondRemoved = vi.spyOn(secondController.signal, "removeEventListener");
    const first = manager.getValidAccessToken({ signal: firstController.signal });
    await refresh.started;
    const second = manager.getValidAccessToken({ signal: secondController.signal });
    await flushTurn();

    refresh.succeed();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "access-2",
      "access-2",
    ]);

    expect(firstAdded).toHaveBeenCalledTimes(1);
    expect(firstRemoved).toHaveBeenCalledTimes(1);
    expect(secondAdded).toHaveBeenCalledTimes(1);
    expect(secondRemoved).toHaveBeenCalledTimes(1);
  });

  it("aborts the real upstream socket when its only subscriber cancels without changing Vault or status", async () => {
    const { dataDir, store } = await tempStore();
    const initial = expiredRecord();
    await store.replace(initial);
    const encryptedPath = path.join(dataDir, "credentials.enc");
    const ciphertextBefore = await readFile(encryptedPath);
    const server = await hangingTokenServer();
    cleanups.push(server.close);
    const manager = new TokenManager(
      store,
      new AliyunHttpClient({ baseUrl: server.baseUrl, clock: () => NOW }),
      () => NOW,
    );
    const controller = new AbortController();
    const caller = manager.getValidAccessToken({ signal: controller.signal });
    await server.requestReceived;

    controller.abort();
    const [callerOutcome, socketOutcome] = await Promise.all([
      outcomeWithin(caller),
      outcomeWithin(server.upstreamSocketClosed),
    ]);
    await flushTurn();

    expect(callerOutcome).toEqual({
      status: "rejected",
      reason: expect.objectContaining({ code: "TOKEN_ENDPOINT_UNAVAILABLE" }),
    });
    expect(socketOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect(server.activeSockets()).toBe(0);
    expect(await readFile(encryptedPath)).toEqual(ciphertextBefore);
    await expect(store.read()).resolves.toEqual(initial);
    await expect(manager.status()).resolves.toBe("ready");
  });

  it("shares one genuine upstream failure across live subscribers and records degraded status", async () => {
    const initial = expiredRecord();
    const store = memoryVault(initial);
    const refresh = controlledRefresh();
    const manager = new TokenManager(store.vault, refresh.aliyun, () => NOW);
    const first = manager.getValidAccessToken();
    await refresh.started;
    const second = manager.getValidAccessToken();
    await flushTurn();
    const failure = new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");

    refresh.fail(failure);
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toEqual({ status: "rejected", reason: failure });
    expect(outcomes[1]).toEqual({ status: "rejected", reason: failure });
    expect(refresh.calls()).toBe(1);
    expect(store.current()).toBe(initial);
    await expect(manager.status()).resolves.toBe("degraded");
  });

  it("propagates caller cancellation into token refresh without mutating the Vault", async () => {
    const { store } = await tempStore();
    const initial = expiredRecord();
    await store.replace(initial);
    const server = await fakeServer(successResponse());
    const manager = new TokenManager(store, client(server), () => NOW);
    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.getValidAccessToken({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "TOKEN_ENDPOINT_UNAVAILABLE" });
    expect(server.requests).toEqual([]);
    await expect(store.read()).resolves.toEqual(initial);
  });

  it("returns the winning access token when rotated-token CAS loses", async () => {
    const { store } = await tempStore();
    const initial = expiredRecord();
    const winner = expiredRecord(2, {
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
      accessTokenExpiresAt: new Date(NOW + 7_200_000).toISOString(),
    });
    await store.replace(initial);
    const losingVault = {
      read: () => store.read(),
      async replaceIfVersion(expected: number, _candidate: CredentialRecord) {
        expect(expected).toBe(1);
        expect(await store.replaceIfVersion(expected, winner)).toBe(true);
        return false;
      },
    };
    const server = await fakeServer(successResponse());
    const manager = new TokenManager(losingVault, client(server), () => NOW);

    await expect(manager.getValidAccessToken()).resolves.toBe("winner-access");
    await expect(store.read()).resolves.toEqual(winner);
  });

  it("avoids a forced refresh when another writer already changed the expected token", async () => {
    const { store } = await tempStore();
    await store.replace(expiredRecord(2, {
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
    }));
    const server = await fakeServer(successResponse());
    const manager = new TokenManager(store, client(server), () => NOW);

    await expect(manager.forceRefresh("access-1")).resolves.toBe("winner-access");
    expect(server.requests).toEqual([]);
  });

  it("keeps same-version reauth state after returning a fresh access token", async () => {
    const { store } = await tempStore();
    await store.replace(expiredRecord(1, {
      accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    }));
    const server = await fakeServer({
      status: 400,
      body: { error: "invalid_grant" },
    });
    const manager = new TokenManager(store, client(server), () => NOW);
    const refreshError = await rejectedPanSyncError(
      () => manager.forceRefresh(),
    );
    expect(refreshError.code).toBe("REFRESH_TOKEN_REJECTED");

    await expect(manager.getValidAccessToken()).resolves.toBe("access-1");

    await expect(manager.status()).resolves.toBe("reauth_required");
  });

  it("keeps same-version degraded state after an expected-token mismatch", async () => {
    const { store } = await tempStore();
    const initial = expiredRecord(1, {
      accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
    await store.replace(initial);
    const server = await fakeServer({
      status: 503,
      body: { message: "temporarily unavailable" },
    });
    const manager = new TokenManager(store, client(server), () => NOW);
    const refreshError = await rejectedPanSyncError(
      () => manager.forceRefresh(),
    );
    expect(refreshError.code).toBe("TOKEN_ENDPOINT_UNAVAILABLE");
    await store.replace({
      ...initial,
      accessToken: "same-version-access",
    });

    await expect(manager.forceRefresh("access-1")).resolves.toBe(
      "same-version-access",
    );

    await expect(manager.status()).resolves.toBe("degraded");
  });

  it("clears failure state after the stored credential version changes", async () => {
    const { store } = await tempStore();
    await store.replace(expiredRecord(1, {
      accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    }));
    const server = await fakeServer({
      status: 503,
      body: { message: "temporarily unavailable" },
    });
    const manager = new TokenManager(store, client(server), () => NOW);
    await rejectedPanSyncError(() => manager.forceRefresh());
    await store.replace(expiredRecord(2, {
      accessToken: "new-version-access",
      accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    }));

    await expect(manager.getValidAccessToken()).resolves.toBe(
      "new-version-access",
    );
    await expect(manager.status()).resolves.toBe("ready");
  });

  it("reports unconfigured and rejects token access when the vault is empty", async () => {
    const { store } = await tempStore();
    const server = await fakeServer(successResponse());
    const manager = new TokenManager(store, client(server), () => NOW);

    await expect(manager.status()).resolves.toBe("unconfigured");
    const error = await rejectedPanSyncError(
      () => manager.getValidAccessToken(),
    );
    expect(error.code).toBe("CREDENTIALS_REQUIRED");
    expect(server.requests).toEqual([]);
  });

  it.each([
    {
      name: "invalid_grant",
      response: {
        status: 400,
        body: { error: "invalid_grant", detail: "refresh-secret-CANARY" },
      },
      code: "REFRESH_TOKEN_REJECTED",
      status: "reauth_required",
    },
    {
      name: "HTTP 429",
      response: {
        status: 429,
        body: { detail: "refresh-secret-CANARY" },
      },
      code: "RATE_LIMITED",
      status: "degraded",
    },
    {
      name: "HTTP 502",
      response: {
        status: 502,
        body: { detail: "refresh-secret-CANARY" },
      },
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
      status: "degraded",
    },
    {
      name: "HTTP 503",
      response: {
        status: 503,
        body: { detail: "refresh-secret-CANARY" },
      },
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
      status: "degraded",
    },
  ] as const)(
    "keeps the encrypted record unchanged after $name and reports $status",
    async ({ response, code, status }) => {
      const { dataDir, store } = await tempStore();
      await store.replace(expiredRecord());
      const encryptedPath = path.join(dataDir, "credentials.enc");
      const ciphertextBefore = await readFile(encryptedPath);
      const server = await fakeServer(response);
      const manager = new TokenManager(store, client(server), () => NOW);

      const error = await rejectedPanSyncError(
        () => manager.getValidAccessToken(),
      );

      expect(error.code).toBe(code);
      expect(await readFile(encryptedPath)).toEqual(ciphertextBefore);
      await expect(store.read()).resolves.toEqual(expiredRecord());
      await expect(manager.status()).resolves.toBe(status);
    },
  );

  it("keeps the encrypted record unchanged after a timeout and becomes degraded", async () => {
    const { dataDir, store } = await tempStore();
    await store.replace(expiredRecord());
    const encryptedPath = path.join(dataDir, "credentials.enc");
    const ciphertextBefore = await readFile(encryptedPath);
    const server = await fakeServer({ status: 200, hang: true });
    const aliyun = new AliyunHttpClient({
      baseUrl: server.baseUrl,
      clock: () => NOW,
      scheduleTimeout: (callback) => setTimeout(callback, 25),
      cancelTimeout: clearTimeout,
    });
    const manager = new TokenManager(store, aliyun, () => NOW);

    const error = await rejectedPanSyncError(
      () => manager.getValidAccessToken(),
    );

    expect(error.code).toBe("TOKEN_ENDPOINT_UNAVAILABLE");
    expect(await readFile(encryptedPath)).toEqual(ciphertextBefore);
    await expect(store.read()).resolves.toEqual(expiredRecord());
    await expect(manager.status()).resolves.toBe("degraded");
  });

  it("sanitizes a refused transport and preserves the encrypted record", async () => {
    const { dataDir, store } = await tempStore();
    const initial = expiredRecord(1, {
      clientSecret: "transport-secret-CANARY",
      refreshToken: "transport-refresh-CANARY",
    });
    await store.replace(initial);
    const encryptedPath = path.join(dataDir, "credentials.enc");
    const ciphertextBefore = await readFile(encryptedPath);
    const aliyun = new AliyunHttpClient({
      baseUrl: await refusedLocalBaseUrl(),
      clock: () => NOW,
    });
    const manager = new TokenManager(store, aliyun, () => NOW);

    const error = await rejectedPanSyncError(
      () => manager.getValidAccessToken(),
    );

    expect(error.code).toBe("TOKEN_ENDPOINT_UNAVAILABLE");
    expect(error.message).not.toContain("transport-secret-CANARY");
    expect(error.message).not.toContain("transport-refresh-CANARY");
    expect(await readFile(encryptedPath)).toEqual(ciphertextBefore);
    await expect(store.read()).resolves.toEqual(initial);
    await expect(manager.status()).resolves.toBe("degraded");
  });
});
