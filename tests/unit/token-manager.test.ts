import { describe, expect, it, vi } from "vitest";
import {
  TokenManager,
  type TokenCredentialVault,
} from "../../src/credentials/token-manager.js";
import type { CredentialLeaseRunner } from "../../src/credentials/store.js";
import type { CredentialRecord } from "../../src/credentials/types.js";
import { PanSyncError } from "../../src/errors.js";
import type {
  AliyunTokenService,
  OpenListRefreshResult,
} from "../../src/providers/aliyun/types.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const immediateLease: CredentialLeaseRunner = (_key, run) => run({
  assertOwned: async () => undefined,
});

function record(
  credentialVersion = 1,
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  return {
    formatVersion: 2,
    credentialVersion,
    authorizationPageUrl: "http://auth.example.test/custom",
    refreshApiUrl: "http://refresh.example.test/custom/renew",
    refreshToken: `refresh-${credentialVersion}`,
    accessToken: `access-${credentialVersion}`,
    account: {
      userIdMasked: "user-***",
      displayNameMasked: "name-***",
    },
    lastVerifiedAt: "2026-08-01T11:59:00.000Z",
    refreshState: { status: "ready" },
    ...overrides,
  };
}

function memoryVault(initial: CredentialRecord): {
  vault: TokenCredentialVault;
  current(): CredentialRecord;
} {
  let current = initial;
  return {
    vault: {
      async read() {
        return current;
      },
      async replaceIfVersion(expected, candidate, options) {
        if (options?.signal?.aborted === true) {
          throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
        }
        if (current.credentialVersion !== expected) {
          return false;
        }
        current = candidate;
        return true;
      },
    },
    current: () => current,
  };
}

function managerOptions(
  store: TokenCredentialVault,
  tokenService: AliyunTokenService,
  clock: () => number = () => NOW,
) {
  return {
    store,
    tokenService,
    runWithRefreshLease: immediateLease,
    clock,
  };
}

function controlledRefresh(): {
  tokenService: AliyunTokenService;
  started: Promise<void>;
  calls(): number;
  input(): Parameters<AliyunTokenService["refresh"]>[0] | undefined;
  succeed(result?: OpenListRefreshResult): void;
  fail(error: unknown): void;
} {
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveResult: (value: OpenListRefreshResult) => void = () => undefined;
  let rejectResult: (error: unknown) => void = () => undefined;
  const result = new Promise<OpenListRefreshResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let callCount = 0;
  let capturedInput: Parameters<AliyunTokenService["refresh"]>[0] | undefined;

  return {
    tokenService: {
      async refresh(input) {
        callCount += 1;
        capturedInput = input;
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
    input: () => capturedInput,
    succeed: (value = { accessToken: "access-2", refreshToken: "refresh-2" }) => {
      resolveResult(value);
    },
    fail: rejectResult,
  };
}

function immediateTokenService(
  result: OpenListRefreshResult = {
    accessToken: "access-2",
    refreshToken: "refresh-2",
  },
): AliyunTokenService & { refresh: ReturnType<typeof vi.fn> } {
  return {
    refresh: vi.fn(async () => result),
  };
}

type PromiseOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

async function outcomeWithin<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return Promise.race([
    promise.then<PromiseOutcome<T>, PromiseOutcome<T>>(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    ),
    new Promise<PromiseOutcome<T>>((resolve) => {
      setTimeout(() => resolve({ status: "timeout" }), 500);
    }),
  ]);
}

async function flushTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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

describe("TokenManager", () => {
  it("returns a ready non-empty access token without refreshing", async () => {
    const store = memoryVault(record());
    const tokenService = immediateTokenService();
    const manager = new TokenManager(managerOptions(store.vault, tokenService));

    await expect(manager.getValidAccessToken()).resolves.toBe("access-1");
    expect(tokenService.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["degraded", "TOKEN_ENDPOINT_UNAVAILABLE"],
    ["rate_limited", "RATE_LIMITED"],
    ["reauth_required", "REFRESH_TOKEN_REJECTED"],
  ] as const)(
    "throws the persisted %s failure code without refreshing",
    async (status, failureCode) => {
      const store = memoryVault(record(1, {
        refreshState: { status, failureCode },
      }));
      const tokenService = immediateTokenService();
      const manager = new TokenManager(managerOptions(store.vault, tokenService));

      await expect(manager.getValidAccessToken()).rejects.toMatchObject({
        code: failureCode,
      });
      await expect(manager.status()).resolves.toBe(status);
      expect(tokenService.refresh).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty access token in a ready record", async () => {
    const store = memoryVault(record(1, { accessToken: "" }));
    const manager = new TokenManager(managerOptions(
      store.vault,
      immediateTokenService(),
    ));

    await expect(manager.getValidAccessToken()).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
    });
  });

  it("reports unconfigured and rejects token access when the vault is empty", async () => {
    const tokenService = immediateTokenService();
    const manager = new TokenManager({
      store: {
        read: async () => undefined,
        replaceIfVersion: async () => false,
      },
      tokenService,
      runWithRefreshLease: immediateLease,
    });

    await expect(manager.status()).resolves.toBe("unconfigured");
    await expect(manager.getValidAccessToken()).rejects.toMatchObject({
      code: "CREDENTIALS_REQUIRED",
    });
    expect(tokenService.refresh).not.toHaveBeenCalled();
  });

  it("single-flights forced refreshes and CAS-saves both rotated tokens", async () => {
    const store = memoryVault(record());
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: store.vault,
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });

    const pending = Array.from({ length: 20 }, () => manager.forceRefresh());
    await refresh.started;
    refresh.succeed();

    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 20 }, () => "access-2"),
    );
    expect(refresh.calls()).toBe(1);
    expect(refresh.input()).toMatchObject({
      refreshApiUrl: "http://refresh.example.test/custom/renew",
      refreshToken: "refresh-1",
      signal: expect.any(AbortSignal),
    });
    expect(store.current()).toEqual({
      ...record(),
      credentialVersion: 2,
      refreshToken: "refresh-2",
      accessToken: "access-2",
      lastVerifiedAt: "2026-08-01T12:00:00.000Z",
      refreshState: { status: "ready" },
    });
  });

  it("short-circuits when another writer changed the expected access token", async () => {
    const store = memoryVault(record(2, {
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
    }));
    const tokenService = immediateTokenService();
    const manager = new TokenManager(managerOptions(store.vault, tokenService));

    await expect(manager.forceRefresh("access-1")).resolves.toBe("winner-access");
    expect(tokenService.refresh).not.toHaveBeenCalled();
  });

  it("returns the winning access token when rotated-token CAS loses", async () => {
    const initial = record();
    const winner = record(2, {
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
    });
    let current = initial;
    const vault: TokenCredentialVault = {
      read: async () => current,
      async replaceIfVersion(expected) {
        expect(expected).toBe(1);
        current = winner;
        return false;
      },
    };
    const manager = new TokenManager({
      store: vault,
      tokenService: immediateTokenService(),
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });

    await expect(manager.forceRefresh()).resolves.toBe("winner-access");
    expect(current).toBe(winner);
  });

  it.each([
    [
      "RATE_LIMITED with Retry-After",
      new PanSyncError("RATE_LIMITED", { retryAfterMs: 5 * 60_000 }),
      {
        status: "rate_limited",
        notBefore: "2026-08-01T12:05:00.000Z",
        failureCode: "RATE_LIMITED",
      },
    ],
    [
      "RATE_LIMITED with an immediate Retry-After",
      new PanSyncError("RATE_LIMITED", { retryAfterMs: 0 }),
      {
        status: "rate_limited",
        notBefore: "2026-08-01T12:00:00.000Z",
        failureCode: "RATE_LIMITED",
      },
    ],
    [
      "RATE_LIMITED with an out-of-Date-range Retry-After",
      new PanSyncError("RATE_LIMITED", {
        retryAfterMs: 8_640_000_000_000_000,
      }),
      {
        status: "rate_limited",
        notBefore: "2026-08-01T13:00:00.000Z",
        failureCode: "RATE_LIMITED",
      },
    ],
    [
      "RATE_LIMITED without Retry-After",
      new PanSyncError("RATE_LIMITED"),
      {
        status: "rate_limited",
        notBefore: "2026-08-01T13:00:00.000Z",
        failureCode: "RATE_LIMITED",
      },
    ],
    [
      "network, timeout, or 5xx failure",
      new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE"),
      {
        status: "degraded",
        notBefore: "2026-08-01T12:01:00.000Z",
        failureCode: "TOKEN_ENDPOINT_UNAVAILABLE",
      },
    ],
    [
      "rejected refresh token",
      new PanSyncError("REFRESH_TOKEN_REJECTED"),
      {
        status: "reauth_required",
        failureCode: "REFRESH_TOKEN_REJECTED",
      },
    ],
  ] as const)("persists %s before rejecting", async (_label, failure, refreshState) => {
    const initial = record();
    const store = memoryVault(initial);
    const tokenService: AliyunTokenService = {
      async refresh() {
        throw failure;
      },
    };
    const manager = new TokenManager(managerOptions(store.vault, tokenService));

    const error = await rejectedPanSyncError(() => manager.forceRefresh());

    expect(error.code).toBe(failure.code);
    expect(store.current()).toEqual({
      ...initial,
      credentialVersion: 2,
      refreshState,
    });
    await expect(manager.status()).resolves.toBe(refreshState.status);
  });

  it.each([
    [
      "degraded",
      "TOKEN_ENDPOINT_UNAVAILABLE",
      "2026-08-01T12:01:00.000Z",
    ],
    ["rate_limited", "RATE_LIMITED", "2026-08-01T13:00:00.000Z"],
  ] as const)(
    "blocks persisted %s cooldown after restart and allows refresh exactly at notBefore",
    async (status, failureCode, notBefore) => {
      let now = NOW;
      const store = memoryVault(record(2, {
        refreshState: { status, failureCode, notBefore },
      }));
      const tokenService = immediateTokenService();
      const manager = new TokenManager(managerOptions(
        store.vault,
        tokenService,
        () => now,
      ));

      await expect(manager.forceRefresh()).rejects.toMatchObject({
        code: failureCode,
      });
      expect(tokenService.refresh).not.toHaveBeenCalled();

      now = Date.parse(notBefore);
      await expect(manager.forceRefresh()).resolves.toBe("access-2");
      expect(tokenService.refresh).toHaveBeenCalledTimes(1);
      expect(store.current().refreshState).toEqual({ status: "ready" });
    },
  );

  it("blocks a persisted reauth requirement after restart without an upstream request", async () => {
    const store = memoryVault(record(2, {
      refreshState: {
        status: "reauth_required",
        failureCode: "REFRESH_TOKEN_REJECTED",
      },
    }));
    const tokenService = immediateTokenService();
    const manager = new TokenManager(managerOptions(store.vault, tokenService));

    await expect(manager.forceRefresh()).rejects.toMatchObject({
      code: "REFRESH_TOKEN_REJECTED",
    });
    expect(tokenService.refresh).not.toHaveBeenCalled();
  });

  it("lets a cancelled joiner leave a shared refresh without cancelling its leader", async () => {
    const store = memoryVault(record());
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: store.vault,
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });
    const leader = manager.forceRefresh();
    await refresh.started;
    const controller = new AbortController();
    const joiner = manager.forceRefresh(undefined, { signal: controller.signal });
    controller.abort();

    const joinerOutcome = await outcomeWithin(joiner);
    expect(refresh.input()?.signal?.aborted).toBe(false);
    refresh.succeed();

    await expect(leader).resolves.toBe("access-2");
    expect(joinerOutcome).toEqual({
      status: "rejected",
      reason: expect.objectContaining({ code: "TOKEN_ENDPOINT_UNAVAILABLE" }),
    });
    expect(refresh.calls()).toBe(1);
  });

  it("lets an unsignaled joiner survive cancellation of the first subscriber", async () => {
    const store = memoryVault(record());
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: store.vault,
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
    });
    const leaderController = new AbortController();
    const leader = manager.forceRefresh(undefined, {
      signal: leaderController.signal,
    });
    await refresh.started;
    const joiner = manager.forceRefresh();
    await flushTurn();

    leaderController.abort();
    const leaderOutcome = await outcomeWithin(leader);
    const upstreamWasAborted = refresh.input()?.signal?.aborted;
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
  });

  it("broadcasts one shared refresh failure to every live subscriber", async () => {
    const initial = record();
    const store = memoryVault(initial);
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: store.vault,
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });
    const first = manager.forceRefresh();
    await refresh.started;
    const second = manager.forceRefresh();
    await flushTurn();
    const failure = new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");

    refresh.fail(failure);
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(refresh.calls()).toBe(1);
    expect(store.current()).toEqual({
      ...initial,
      credentialVersion: 2,
      refreshState: {
        status: "degraded",
        notBefore: new Date(NOW + 60_000).toISOString(),
        failureCode: "TOKEN_ENDPOINT_UNAVAILABLE",
      },
    });
    await expect(manager.status()).resolves.toBe("degraded");
  });

  it("removes every caller abort listener after a shared refresh settles", async () => {
    const store = memoryVault(record());
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: store.vault,
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstAdded = vi.spyOn(firstController.signal, "addEventListener");
    const firstRemoved = vi.spyOn(firstController.signal, "removeEventListener");
    const secondAdded = vi.spyOn(secondController.signal, "addEventListener");
    const secondRemoved = vi.spyOn(secondController.signal, "removeEventListener");
    const first = manager.forceRefresh(undefined, {
      signal: firstController.signal,
    });
    await refresh.started;
    const second = manager.forceRefresh(undefined, {
      signal: secondController.signal,
    });
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

  it("aborts the shared refresh when its only subscriber cancels", async () => {
    const store = memoryVault(record());
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: store.vault,
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
    });
    const controller = new AbortController();
    const pending = manager.forceRefresh(undefined, { signal: controller.signal });
    await refresh.started;

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
    });
    expect(refresh.input()?.signal?.aborted).toBe(true);
    expect(store.current()).toEqual(record());
  });

  it("clearSnapshots cancels in-flight work without changing the Vault", async () => {
    const store = memoryVault(record());
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: store.vault,
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
    });
    const pending = manager.forceRefresh();
    await refresh.started;

    manager.clearSnapshots();

    await expect(pending).rejects.toMatchObject({
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
    });
    expect(refresh.input()?.signal?.aborted).toBe(true);
    expect(store.current()).toEqual(record());
  });

  it("returns committed refresh success when abort arrives as the CAS completes", async () => {
    const controller = new AbortController();
    let current = record();
    const manager = new TokenManager({
      store: {
        read: async () => current,
        async replaceIfVersion(expected, candidate) {
          expect(expected).toBe(1);
          current = candidate;
          controller.abort();
          return true;
        },
      },
      tokenService: immediateTokenService(),
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });

    await expect(manager.forceRefresh(undefined, {
      signal: controller.signal,
    })).resolves.toBe("access-2");
    expect(current).toMatchObject({
      credentialVersion: 2,
      accessToken: "access-2",
      refreshToken: "refresh-2",
      refreshState: { status: "ready" },
    });
  });

  it("does not let clearSnapshots cancel a refresh after commit begins", async () => {
    const initial = record();
    let current = initial;
    let notifyReplaceStarted: (() => void) | undefined;
    const replaceStarted = new Promise<void>((resolve) => {
      notifyReplaceStarted = resolve;
    });
    let releaseReplace: (() => void) | undefined;
    const replaceReleased = new Promise<void>((resolve) => {
      releaseReplace = resolve;
    });
    const manager = new TokenManager({
      store: {
        read: async () => current,
        async replaceIfVersion(_expected, candidate) {
          notifyReplaceStarted?.();
          await replaceReleased;
          current = candidate;
          return true;
        },
      },
      tokenService: immediateTokenService(),
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });
    const pending = manager.forceRefresh();
    await replaceStarted;

    manager.clearSnapshots();
    releaseReplace?.();

    await expect(pending).resolves.toBe("access-2");
    expect(current).toMatchObject({
      credentialVersion: 2,
      accessToken: "access-2",
      refreshState: { status: "ready" },
    });
  });

  it("returns the committed refresh failure when abort arrives as its CAS completes", async () => {
    const controller = new AbortController();
    let current = record();
    const failure = new PanSyncError("RATE_LIMITED", {
      retryAfterMs: 5 * 60_000,
    });
    const manager = new TokenManager({
      store: {
        read: async () => current,
        async replaceIfVersion(expected, candidate) {
          expect(expected).toBe(1);
          current = candidate;
          controller.abort();
          return true;
        },
      },
      tokenService: {
        async refresh() {
          throw failure;
        },
      },
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });

    await expect(manager.forceRefresh(undefined, {
      signal: controller.signal,
    })).rejects.toBe(failure);
    expect(current).toMatchObject({
      credentialVersion: 2,
      refreshState: {
        status: "rate_limited",
        notBefore: "2026-08-01T12:05:00.000Z",
        failureCode: "RATE_LIMITED",
      },
    });
  });

  it("returns cancellation without mutation when abort wins after upstream success but before commit", async () => {
    const controller = new AbortController();
    const initial = record();
    let current = initial;
    let replaceCalls = 0;
    const refresh = controlledRefresh();
    const manager = new TokenManager({
      store: {
        read: async () => current,
        async replaceIfVersion(_expected, candidate) {
          replaceCalls += 1;
          current = candidate;
          return true;
        },
      },
      tokenService: refresh.tokenService,
      runWithRefreshLease: immediateLease,
      clock: () => NOW,
    });

    const pending = manager.forceRefresh(undefined, {
      signal: controller.signal,
    });
    await refresh.started;
    refresh.succeed();
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "TOKEN_ENDPOINT_UNAVAILABLE",
    });
    expect(replaceCalls).toBe(0);
    expect(current).toBe(initial);
  });
});
