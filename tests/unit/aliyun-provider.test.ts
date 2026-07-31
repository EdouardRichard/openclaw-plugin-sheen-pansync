import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudDriveProvider } from "../../src/contracts.js";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { PanSyncError } from "../../src/errors.js";
import { ProviderRegistry } from "../../src/provider-registry.js";
import { AliyunHttpClient } from "../../src/providers/aliyun/http.js";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";
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
    httpClient: new AliyunHttpClient({
      baseUrl: server.baseUrl,
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

describe("AliyunProvider credential validation", () => {
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
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-candidate",
      credentialVersion: 7,
    });

    expect(server.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/oauth/access_token" },
      { method: "POST", path: "/adrive/v1.0/user/getDriveInfo" },
    ]);
    expect(result).toMatchObject({
      formatVersion: 1,
      credentialVersion: 7,
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-rotated",
      accessToken: "access-rotated",
      accessTokenExpiresAt: "2026-07-31T14:00:00.000Z",
      lastVerifiedAt: "2026-07-31T12:00:00.000Z",
    });
    expect(result.account.userIdMasked).not.toBe("unmasked-user-123456789");
    expect(result.account.displayNameMasked).not.toBe("Unmasked Account Name");
    expect(JSON.stringify(result.account)).not.toContain("unmasked-user-123456789");
    expect(JSON.stringify(result.account)).not.toContain("Unmasked Account Name");
    expect(Number.isNaN(Date.parse(result.accessTokenExpiresAt))).toBe(false);
  });

  it("preserves a transient token-endpoint failure as TOKEN_ENDPOINT_UNAVAILABLE", async () => {
    const server = await fakeServer([{
      status: 503,
      body: { detail: "transient-secret-CANARY" },
    }]);

    const error = await rejectedPanSyncError(() =>
      provider(server).validateCredentials({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-candidate",
      })
    );

    expect(error.code).toBe("TOKEN_ENDPOINT_UNAVAILABLE");
    expect(error.message).not.toContain("transient-secret-CANARY");
  });

  it("rejects an invalid candidate before a caller can replace old credentials", async () => {
    const oldRecord: CredentialRecord = {
      formatVersion: 1,
      credentialVersion: 3,
      clientId: "old-client",
      clientSecret: "old-secret",
      refreshToken: "old-refresh",
      accessToken: "old-access",
      accessTokenExpiresAt: "2026-07-31T13:00:00.000Z",
      account: { userIdMasked: "old***id" },
      lastVerifiedAt: "2026-07-31T11:00:00.000Z",
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
        clientId: "candidate-client",
        clientSecret: "candidate-secret-CANARY",
        refreshToken: "candidate-refresh-CANARY",
      });
      await store.replace(validated);
    };
    const error = await rejectedPanSyncError(saveValidatedCandidate);

    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).not.toContain("candidate-secret-CANARY");
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

  it("maps a second 401 to AUTHORIZATION_REVOKED", async () => {
    const server = await fakeServer([
      { status: 401, body: { code: "AccessTokenInvalid" } },
      { status: 401, body: { code: "AccessTokenInvalidAgain" } },
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
