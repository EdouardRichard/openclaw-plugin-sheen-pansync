import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudDriveProvider } from "../../src/contracts.js";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { PanSyncError } from "../../src/errors.js";
import { ProviderRegistry } from "../../src/provider-registry.js";
import { OpenListTokenService } from "../../src/providers/aliyun/openlist-token-service.js";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";
import { AliyunAuthorizedClient } from "../../src/providers/aliyun/upload.js";
import type { AliyunFetch } from "../../src/providers/aliyun/types.js";
import {
  startFakeAliyunServer,
  type FakeAliyunResponse,
  type FakeAliyunServer,
} from "../helpers/fake-aliyun-server.js";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fakeServer(
  responses: FakeAliyunResponse[],
): Promise<FakeAliyunServer> {
  const server = await startFakeAliyunServer(responses);
  cleanups.push(server.close);
  return server;
}

function provider(
  server: FakeAliyunServer,
  forceRefresh = vi.fn<(token?: string) => Promise<string>>(),
): AliyunProvider {
  return new AliyunProvider({
    tokenService: new OpenListTokenService({
      clock: () => NOW,
    }),
    baseUrl: server.baseUrl,
    tokenManager: { forceRefresh },
    clock: () => NOW,
  });
}

function driveInfo(overrides: Record<string, unknown> = {}): FakeAliyunResponse {
  return {
    status: 200,
    body: {
      user_id: "unmasked-user-123456789",
      name: "Unmasked Account Name",
      default_drive_id: "drive-default",
      resource_drive_id: "drive-resource",
      backup_drive_id: "drive-backup",
      ...overrides,
    },
  };
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorizationHeader(
  call: Parameters<AliyunFetch>,
): string | null {
  return new Headers(call[1]?.headers).get("authorization");
}

describe("AliyunAuthorizedClient token failure retry", () => {
  it.each([
    [401, { code: "AccessTokenInvalid" }],
    [401, { code: "AccessTokenExpired" }],
    [400, { code: "I400JD" }],
  ] as const)(
    "refreshes once for explicit token code at HTTP %i and retries with the winning token",
    async (status, body) => {
      const fetch = vi.fn<AliyunFetch>()
        .mockResolvedValueOnce(jsonResponse(status, body))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      const forceRefresh = vi.fn(async () => "access-new");
      const client = new AliyunAuthorizedClient({ fetch, tokenManager: {
        forceRefresh,
      } });

      await expect(client.post(
        "/adrive/v1.0/example",
        "access-old",
        { request: true },
        { failureCode: "REMOTE_DIRECTORY_FAILED" },
      )).resolves.toEqual({
        accessToken: "access-new",
        body: { ok: true },
        alreadyExisting: false,
      });

      expect(forceRefresh).toHaveBeenCalledOnce();
      expect(forceRefresh).toHaveBeenCalledWith("access-old");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(authorizationHeader(fetch.mock.calls[0]!)).toBe(
        "Bearer access-old",
      );
      expect(authorizationHeader(fetch.mock.calls[1]!)).toBe(
        "Bearer access-new",
      );
    },
  );

  it.each([
    ["generic 401", 401, {}],
    ["401 business error", 401, { code: "UserNotFound" }],
    ["401 near-match token code", 401, { code: "AccessTokenInvalidAgain" }],
    ["HTTP 403", 403, { code: "Forbidden" }],
    ["HTTP 429", 429, { code: "TooManyRequests" }],
    ["HTTP 500", 500, { code: "InternalError" }],
  ] as const)(
    "does not refresh for %s",
    async (_name, status, body) => {
      const fetch = vi.fn<AliyunFetch>(async () => jsonResponse(status, body));
      const forceRefresh = vi.fn(async () => "access-new");
      const client = new AliyunAuthorizedClient({ fetch, tokenManager: {
        forceRefresh,
      } });

      await expect(client.post(
        "/adrive/v1.0/example",
        "access-old",
        {},
        { failureCode: "REMOTE_DIRECTORY_FAILED" },
      )).rejects.toBeInstanceOf(PanSyncError);

      expect(forceRefresh).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("does not refresh after a network failure", async () => {
    const fetch = vi.fn<AliyunFetch>(async () => {
      throw new Error("network-secret-CANARY");
    });
    const forceRefresh = vi.fn(async () => "access-new");
    const client = new AliyunAuthorizedClient({ fetch, tokenManager: {
      forceRefresh,
    } });

    await expect(client.post(
      "/adrive/v1.0/example",
      "access-old",
      {},
      { failureCode: "REMOTE_DIRECTORY_FAILED" },
    )).rejects.toMatchObject({ code: "REMOTE_DIRECTORY_FAILED" });
    expect(forceRefresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not refresh for a Unicode near-match of an ASCII token code", async () => {
    const fetch = vi.fn<AliyunFetch>(async () => jsonResponse(401, {
      code: "AccessToKenInvalid",
    }));
    const forceRefresh = vi.fn(async () => "access-new");
    const client = new AliyunAuthorizedClient({ fetch, tokenManager: {
      forceRefresh,
    } });

    await expect(client.post(
      "/adrive/v1.0/example",
      "access-old",
      {},
      { failureCode: "REMOTE_DIRECTORY_FAILED" },
    )).rejects.toMatchObject({ code: "REMOTE_DIRECTORY_FAILED" });
    expect(forceRefresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not refresh when token-failure retry is disabled", async () => {
    const fetch = vi.fn<AliyunFetch>(async () => jsonResponse(401, {
      code: "AccessTokenInvalid",
    }));
    const forceRefresh = vi.fn(async () => "access-new");
    const client = new AliyunAuthorizedClient({ fetch, tokenManager: {
      forceRefresh,
    } });

    await expect(client.post(
      "/adrive/v1.0/example",
      "access-old",
      {},
      {
        failureCode: "CREDENTIALS_INVALID",
        retryTokenFailure: false,
      },
    )).rejects.toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(forceRefresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps a repeated explicit token failure to AUTHORIZATION_REVOKED", async () => {
    const fetch = vi.fn<AliyunFetch>()
      .mockResolvedValueOnce(jsonResponse(401, {
        code: "AccessTokenInvalid",
      }))
      .mockResolvedValueOnce(jsonResponse(400, {
        error: "AccessTokenExpired",
      }));
    const forceRefresh = vi.fn(async () => "access-new");
    const client = new AliyunAuthorizedClient({ fetch, tokenManager: {
      forceRefresh,
    } });

    await expect(client.post(
      "/adrive/v1.0/example",
      "access-old",
      {},
      { failureCode: "REMOTE_DIRECTORY_FAILED" },
    )).rejects.toMatchObject({ code: "AUTHORIZATION_REVOKED" });
    expect(forceRefresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("AliyunProvider credential validation", () => {
  it.each([
    ["authorization page URL", { authorizationPageUrl: "" }],
    ["whitespace authorization page URL", { authorizationPageUrl: " \t\n " }],
    ["refresh API URL", { refreshApiUrl: "x".repeat(4097) }],
    ["whitespace refresh API URL", { refreshApiUrl: " \t\n " }],
    ["refresh token", { refreshToken: "" }],
    ["whitespace refresh token", { refreshToken: " \t\n " }],
  ] as const)("rejects an invalid %s before contacting OpenList", async (_name, override) => {
    const server = await fakeServer([
      {
        status: 200,
        body: {
          access_token: "access-must-not-be-used",
          refresh_token: "refresh-must-not-be-used",
        },
      },
      driveInfo(),
    ]);
    const error = await rejectedPanSyncError(() => provider(server).validateCredentials({
      authorizationPageUrl: "http://auth.example.test/custom",
      refreshApiUrl: `${server.baseUrl}/custom/renew`,
      refreshToken: "refresh-candidate",
      ...override,
    }));

    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(server.requests).toEqual([]);
  });

  it("refreshes the candidate before drive discovery and returns only masked account identifiers", async () => {
    const server = await fakeServer([
      {
        status: 200,
        body: {
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
          expires_in: 7_200,
        },
      },
      driveInfo(),
    ]);

    const resolved: CloudDriveProvider = new ProviderRegistry(
      [provider(server)],
      "aliyun",
    ).resolve("aliyun");
    const result = await resolved.validateCredentials({
      authorizationPageUrl: "http://auth.example.test/custom",
      refreshApiUrl: `${server.baseUrl}/custom/renew`,
      refreshToken: "refresh-candidate",
      credentialVersion: 7,
    });

    expect(server.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/custom/renew?refresh_ui=refresh-candidate&server_use=true&driver_txt=alicloud_qr" },
      { method: "POST", path: "/adrive/v1.0/user/getDriveInfo" },
    ]);
    expect(result).toMatchObject({
      formatVersion: 2,
      credentialVersion: 7,
      authorizationPageUrl: "http://auth.example.test/custom",
      refreshApiUrl: `${server.baseUrl}/custom/renew`,
      refreshToken: "refresh-rotated",
      accessToken: "access-rotated",
      lastVerifiedAt: "2026-07-31T12:00:00.000Z",
      refreshState: { status: "ready" },
    });
    expect(result.account.userIdMasked).not.toBe("unmasked-user-123456789");
    expect(result.account.displayNameMasked).not.toBe("Unmasked Account Name");
    expect(JSON.stringify(result.account)).not.toContain("unmasked-user-123456789");
    expect(JSON.stringify(result.account)).not.toContain("Unmasked Account Name");
  });

  it.each([
    [503, "TOKEN_ENDPOINT_UNAVAILABLE"],
    [429, "RATE_LIMITED"],
  ] as const)("preserves OpenList HTTP %i as %s", async (status, code) => {
    const server = await fakeServer([{
      status,
      body: { detail: "transient-secret-CANARY" },
    }]);

    const error = await rejectedPanSyncError(() =>
      provider(server).validateCredentials({
        authorizationPageUrl: "http://auth.example.test/custom",
        refreshApiUrl: `${server.baseUrl}/custom/renew`,
        refreshToken: "refresh-candidate",
      })
    );

    expect(error.code).toBe(code);
    expect(error.message).not.toContain("transient-secret-CANARY");
  });

  it("rejects an invalid candidate before a caller can replace old credentials", async () => {
    const oldRecord: CredentialRecord = {
      formatVersion: 2,
      credentialVersion: 3,
      authorizationPageUrl: "http://old-auth.example.test/custom",
      refreshApiUrl: "http://old-refresh.example.test/custom/renew",
      refreshToken: "old-refresh",
      accessToken: "old-access",
      account: { userIdMasked: "old***id" },
      lastVerifiedAt: "2026-07-31T11:00:00.000Z",
      refreshState: { status: "ready" },
    };
    const store = {
      record: oldRecord,
      read: vi.fn(async () => store.record),
      replace: vi.fn(async (candidate: CredentialRecord) => {
        store.record = candidate;
      }),
    };
    const server = await fakeServer([
      {
        status: 400,
        body: {
          error: "invalid_grant",
          detail: "candidate-secret-CANARY",
        },
      },
    ]);

    const saveValidatedCandidate = async () => {
      const validated = await provider(server).validateCredentials({
        authorizationPageUrl: "http://candidate-auth.example.test/custom",
        refreshApiUrl: `${server.baseUrl}/custom/renew`,
        refreshToken: "candidate-refresh-CANARY",
      });
      await store.replace(validated);
    };
    const error = await rejectedPanSyncError(saveValidatedCandidate);

    expect(error.code).toBe("REFRESH_TOKEN_REJECTED");
    expect(error.message).not.toContain("candidate-refresh-CANARY");
    expect(store.replace).not.toHaveBeenCalled();
    await expect(store.read()).resolves.toBe(oldRecord);
  });
});

describe("AliyunProvider directory traversal", () => {
  it("paginates each segment, creates only missing folders, and recovers from a create race", async () => {
    const server = await fakeServer([
      driveInfo(),
      {
        status: 200,
        body: {
          items: [{ file_id: "other", name: "other", type: "folder" }],
          next_marker: "page-2",
        },
      },
      { status: 200, body: { items: [], next_marker: "" } },
      { status: 201, body: { file_id: "folder-share" } },
      {
        status: 200,
        body: {
          items: [{
            file_id: "folder-reports",
            name: "reports",
            type: "folder",
          }],
          next_marker: "",
        },
      },
      { status: 200, body: { items: [], next_marker: "" } },
      {
        status: 409,
        body: {
          code: "AlreadyExist.File",
          message: "name already exists",
        },
      },
      {
        status: 200,
        body: {
          items: [{
            file_id: "folder-2026",
            name: "2026",
            type: "folder",
          }],
          next_marker: "",
        },
      },
    ]);

    await expect(
      provider(server).ensureDirectory(
        "/openClawShare/reports/2026",
        "access-old",
      ),
    ).resolves.toMatchObject({
      id: "folder-2026",
      path: "/openClawShare/reports/2026",
      providerState: { driveId: "drive-default" },
    });

    expect(server.requests.slice(1).map(({ path }) => path)).toEqual([
      "/adrive/v1.0/openFile/list",
      "/adrive/v1.0/openFile/list",
      "/adrive/v1.0/openFile/create",
      "/adrive/v1.0/openFile/list",
      "/adrive/v1.0/openFile/list",
      "/adrive/v1.0/openFile/create",
      "/adrive/v1.0/openFile/list",
    ]);
    expect(server.requests[1]?.body).toEqual({
      drive_id: "drive-default",
      parent_file_id: "root",
      limit: 200,
    });
    expect(server.requests[2]?.body).toEqual({
      drive_id: "drive-default",
      parent_file_id: "root",
      limit: 200,
      marker: "page-2",
    });
    expect(
      server.requests
        .filter(({ path }) => path.endsWith("/create"))
        .map(({ body }) => body),
    ).toEqual([
      {
        drive_id: "drive-default",
        parent_file_id: "root",
        name: "openClawShare",
        type: "folder",
        check_name_mode: "refuse",
      },
      {
        drive_id: "drive-default",
        parent_file_id: "folder-reports",
        name: "2026",
        type: "folder",
        check_name_mode: "refuse",
      },
    ]);
  });

  it("refreshes once after a 401 and retries with the returned token", async () => {
    const server = await fakeServer([
      { status: 401, body: { code: "AccessTokenInvalid" } },
      driveInfo(),
    ]);
    const forceRefresh = vi.fn(async () => "access-new");

    await expect(
      provider(server, forceRefresh).ensureDirectory("/", "access-old"),
    ).resolves.toMatchObject({
      id: "root",
      providerState: { driveId: "drive-default" },
    });

    expect(forceRefresh).toHaveBeenCalledOnce();
    expect(forceRefresh).toHaveBeenCalledWith("access-old");
    expect(server.requests).toHaveLength(2);
  });

  it("maps a second explicit token failure to AUTHORIZATION_REVOKED", async () => {
    const server = await fakeServer([
      { status: 401, body: { code: "AccessTokenInvalid" } },
      { status: 400, body: { code: "AccessTokenExpired" } },
    ]);
    const forceRefresh = vi.fn(async () => "access-new");

    const error = await rejectedPanSyncError(() =>
      provider(server, forceRefresh).ensureDirectory("/", "access-old")
    );

    expect(error.code).toBe("AUTHORIZATION_REVOKED");
    expect(forceRefresh).toHaveBeenCalledOnce();
  });

  it("maps HTTP 429 without exposing the response body", async () => {
    const server = await fakeServer([
      {
        status: 429,
        body: { detail: "authorization-secret-CANARY" },
      },
    ]);

    const error = await rejectedPanSyncError(() =>
      provider(server).ensureDirectory("/", "access-secret-CANARY")
    );

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).not.toContain("authorization-secret-CANARY");
  });
});
