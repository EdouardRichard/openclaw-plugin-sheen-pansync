import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PanSyncError, safeErrorDetails } from "../../src/errors.js";
import {
  OpenListTokenService,
} from "../../src/providers/aliyun/openlist-token-service.js";
import {
  startFakeOpenListServer,
  type FakeOpenListResponse,
  type FakeOpenListServer,
} from "../helpers/fake-openlist-server.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fakeServer(
  response: FakeOpenListResponse | FakeOpenListResponse[],
): Promise<FakeOpenListServer> {
  const server = await startFakeOpenListServer(response);
  cleanups.push(server.close);
  return server;
}

function client(): OpenListTokenService {
  return new OpenListTokenService({ clock: () => NOW });
}

function successResponse(): FakeOpenListResponse {
  return {
    status: 200,
    body: {
      access_token: "access-2",
      refresh_token: "refresh-2",
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

function expectSafeError(error: PanSyncError, code: PanSyncError["code"]): void {
  expect(error.code).toBe(code);
  expect(safeErrorDetails(error)).toEqual({ code });
  expect(JSON.stringify(safeErrorDetails(error))).toBe(`{"code":"${code}"}`);
}

async function refusedLocalUrl(): Promise<string> {
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
    throw new Error("refused endpoint fixture did not bind a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  });
  return `http://127.0.0.1:${address.port}/renew`;
}

describe("OpenListTokenService", () => {
  it("gets an OpenList renewal URL without credentials in headers or body", async () => {
    const server = await fakeServer(successResponse());

    const result = await client().refresh({
      refreshApiUrl: `${server.baseUrl}/alicloud/renewapi`,
      refreshToken: "refresh-CANARY",
    });

    const request = server.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error("missing OpenList request");
    }
    expect(request.method).toBe("GET");
    expect(new URL(request.url).searchParams.get("refresh_ui")).toBe("refresh-CANARY");
    expect(new URL(request.url).searchParams.get("server_use")).toBe("true");
    expect(new URL(request.url).searchParams.get("driver_txt")).toBe("alicloud_qr");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toBe("");
    expect(result).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
  });

  it("preserves a configured renewal path and query parameters", async () => {
    const server = await fakeServer(successResponse());

    await client().refresh({
      refreshApiUrl: `${server.baseUrl}/custom/renew?tenant=one`,
      refreshToken: "refresh-1",
    });

    const request = server.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error("missing OpenList request");
    }
    const url = new URL(request.url);
    expect(url.pathname).toBe("/custom/renew");
    expect(url.searchParams.get("tenant")).toBe("one");
    expect(url.searchParams.get("refresh_ui")).toBe("refresh-1");
    expect(url.searchParams.get("server_use")).toBe("true");
    expect(url.searchParams.get("driver_txt")).toBe("alicloud_qr");
  });

  it.each([
    [400, "REFRESH_TOKEN_REJECTED"],
    [401, "REFRESH_TOKEN_REJECTED"],
    [404, "REFRESH_TOKEN_REJECTED"],
    [500, "TOKEN_ENDPOINT_UNAVAILABLE"],
    [503, "TOKEN_ENDPOINT_UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const server = await fakeServer({ status, body: { detail: "response-CANARY" } });
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "refresh-CANARY",
    }));

    expectSafeError(error, code);
    expect(error.message).not.toContain("refresh-CANARY");
    expect(error.message).not.toContain("response-CANARY");
  });

  it("exposes delta-seconds retry guidance only internally", async () => {
    const server = await fakeServer({
      status: 429,
      headers: { "retry-after": "42" },
      body: { detail: "rate-CANARY" },
    });
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "refresh-CANARY",
    }));

    expectSafeError(error, "RATE_LIMITED");
    expect(error.retryAfterMs).toBe(42_000);
  });

  it("parses an HTTP-date retry-after relative to the injected clock", async () => {
    const server = await fakeServer({
      status: 429,
      headers: { "retry-after": new Date(NOW + 120_000).toUTCString() },
    });
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "refresh-1",
    }));

    expectSafeError(error, "RATE_LIMITED");
    expect(error.retryAfterMs).toBe(120_000);
  });

  it.each(["invalid", "-1", new Date(NOW - 1_000).toUTCString()])(
    "omits invalid retry-after value %s",
    async (retryAfter) => {
      const server = await fakeServer({
        status: 429,
        headers: { "retry-after": retryAfter },
      });
      const error = await rejectedPanSyncError(() => client().refresh({
        refreshApiUrl: `${server.baseUrl}/renew`,
        refreshToken: "refresh-1",
      }));

      expectSafeError(error, "RATE_LIMITED");
      expect(error.retryAfterMs).toBeUndefined();
    },
  );

  it("omits a future ISO timestamp that is not an HTTP-date", async () => {
    const server = await fakeServer({
      status: 429,
      headers: { "retry-after": new Date(NOW + 120_000).toISOString() },
    });
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "refresh-1",
    }));

    expectSafeError(error, "RATE_LIMITED");
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("rejects a non-JSON successful response without exposing its content", async () => {
    const server = await fakeServer({ status: 200, body: "not-json-response-CANARY" });
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "refresh-CANARY",
    }));

    expectSafeError(error, "REFRESH_TOKEN_REJECTED");
    expect(error.message).not.toContain("not-json-response-CANARY");
  });

  it.each([
    ["access", { access_token: "", refresh_token: "refresh-2" }],
    ["refresh", { access_token: "access-2", refresh_token: "" }],
  ] as const)("rejects an empty %s token", async (_field, body) => {
    const server = await fakeServer({ status: 200, body });
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "refresh-1",
    }));

    expectSafeError(error, "REFRESH_TOKEN_REJECTED");
  });

  it("maps a refused local endpoint to an opaque availability error", async () => {
    const refreshApiUrl = await refusedLocalUrl();
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl,
      refreshToken: "transport-refresh-CANARY",
    }));

    expectSafeError(error, "TOKEN_ENDPOINT_UNAVAILABLE");
    expect(error.message).not.toContain("transport-refresh-CANARY");
  });

  it("maps the 15-second request timeout to an opaque availability error", async () => {
    const server = await fakeServer({ status: 200, hang: true });
    const timeoutDelays: number[] = [];
    const service = new OpenListTokenService({
      clock: () => NOW,
      scheduleTimeout: ((callback: () => void, delayMs?: number) => {
        timeoutDelays.push(delayMs ?? 0);
        return setTimeout(callback, 25);
      }) as typeof setTimeout,
      cancelTimeout: clearTimeout,
    });
    const error = await rejectedPanSyncError(() => service.refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "timeout-refresh-CANARY",
    }));

    expect(timeoutDelays).toEqual([15_000]);
    expectSafeError(error, "TOKEN_ENDPOINT_UNAVAILABLE");
  });

  it("maps caller cancellation to an opaque availability error", async () => {
    const server = await fakeServer({ status: 200, hang: true });
    const controller = new AbortController();
    const pending = client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew`,
      refreshToken: "abort-refresh-CANARY",
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    const error = await rejectedPanSyncError(() => pending);
    expectSafeError(error, "TOKEN_ENDPOINT_UNAVAILABLE");
  });

  it("never serializes response token or endpoint canaries", async () => {
    const endpointCanary = "https://example.invalid/endpoint-CANARY";
    const server = await fakeServer({
      status: 400,
      body: {
        detail: "response-token-CANARY",
        url: endpointCanary,
      },
    });
    const error = await rejectedPanSyncError(() => client().refresh({
      refreshApiUrl: `${server.baseUrl}/renew?upstream=${encodeURIComponent(endpointCanary)}`,
      refreshToken: "request-token-CANARY",
    }));

    expectSafeError(error, "REFRESH_TOKEN_REJECTED");
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("response-token-CANARY");
    expect(serialized).not.toContain("request-token-CANARY");
    expect(JSON.stringify(safeErrorDetails(error))).not.toContain("endpoint-CANARY");
  });
});
