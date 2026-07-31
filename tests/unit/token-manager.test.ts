import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenManager } from "../../src/credentials/token-manager.js";
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
const immediateLease: CredentialLeaseRunner = (_key, run) => run();
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
  const listener = createServer();
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
