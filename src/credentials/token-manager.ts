import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderOperationOptions } from "../contracts.js";
import { PanSyncError } from "../errors.js";
import type { AliyunTokenService } from "../providers/aliyun/types.js";
import type { CredentialLeaseRunner } from "./store.js";
import type { CredentialRecord, RefreshState } from "./types.js";

const REFRESH_LEASE_KEY = "aliyun-token-refresh";
const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 60 * 1_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export type TokenManagerStatus =
  | "unconfigured"
  | "ready"
  | "degraded"
  | "rate_limited"
  | "reauth_required";

export interface TokenCredentialVault {
  read(): Promise<CredentialRecord | undefined>;
  replaceIfVersion(
    expected: number | undefined,
    candidate: CredentialRecord,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
}

export type TokenManagerOptions = {
  store: TokenCredentialVault;
  tokenService: AliyunTokenService;
  runWithRefreshLease: CredentialLeaseRunner;
  clock?: () => number;
};

type LegacyTokenManagerOptions = Omit<
  TokenManagerOptions,
  "runWithRefreshLease"
>;

type RefreshSubscriber = {
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  resolve(token: string): void;
  reject(error: unknown): void;
};

type RefreshOperation = {
  controller: AbortController;
  subscribers: Set<RefreshSubscriber>;
  phase: "refreshing" | "committing";
};

type RefreshOutcome =
  | { status: "fulfilled"; value: string }
  | { status: "rejected"; reason: unknown };

function cancellationError(): PanSyncError {
  return new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
}

function cancellationRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isRepresentableDateTimestamp(value: number): boolean {
  return Number.isSafeInteger(value)
    && Math.abs(value) <= MAX_DATE_TIMESTAMP_MS;
}

function cooldownNotBefore(
  now: number,
  requestedDelayMs: number | undefined,
  fallbackDelayMs: number,
): string {
  const requestedTarget = requestedDelayMs === undefined
    ? Number.NaN
    : now + requestedDelayMs;
  const delayMs = Number.isSafeInteger(requestedDelayMs)
    && requestedDelayMs! >= 0
    && isRepresentableDateTimestamp(requestedTarget)
    ? requestedDelayMs!
    : fallbackDelayMs;
  const fallbackTarget = now + delayMs;
  const notBefore = isRepresentableDateTimestamp(fallbackTarget)
    ? fallbackTarget
    : MAX_DATE_TIMESTAMP_MS;
  return new Date(notBefore).toISOString();
}

export function makeReentrantCredentialLeaseRunner(
  delegate: CredentialLeaseRunner,
): CredentialLeaseRunner {
  const activeLease = new AsyncLocalStorage<
    Parameters<Parameters<CredentialLeaseRunner>[1]>[0]
  >();
  return async (key, run, options = {}) => {
    const inherited = activeLease.getStore();
    if (inherited !== undefined) {
      if (cancellationRequested(options.signal)) {
        throw new Error("credential lease unavailable");
      }
      await inherited.assertOwned();
      return run(inherited);
    }
    return delegate(
      key,
      (lease) => activeLease.run(lease, () => run(lease)),
      options,
    );
  };
}

export class TokenManager {
  readonly #store: TokenCredentialVault;
  readonly #tokenService: AliyunTokenService;
  readonly #runWithRefreshLease: CredentialLeaseRunner;
  readonly #clock: () => number;
  #refreshInFlight: RefreshOperation | undefined;

  constructor(options: LegacyTokenManagerOptions);
  constructor(options: TokenManagerOptions);
  constructor(options: TokenManagerOptions | LegacyTokenManagerOptions) {
    this.#store = options.store;
    this.#tokenService = options.tokenService;
    this.#runWithRefreshLease = "runWithRefreshLease" in options
      ? options.runWithRefreshLease
      : (_key, run) => run({ assertOwned: async () => undefined });
    this.#clock = options.clock ?? Date.now;
  }

  async getValidAccessToken(
    _options: ProviderOperationOptions = {},
  ): Promise<string> {
    const record = await this.#readConfiguredRecord();
    if (record.refreshState.status !== "ready") {
      this.#assertRefreshEligible(record);
      return this.#singleFlightRefresh(record, record.accessToken, _options);
    }
    if (record.accessToken.length === 0) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }
    return record.accessToken;
  }

  async forceRefresh(
    expectedAccessToken?: string,
    options: ProviderOperationOptions = {},
  ): Promise<string> {
    const record = await this.#readConfiguredRecord();
    if (
      expectedAccessToken !== undefined
      && record.accessToken !== expectedAccessToken
    ) {
      if (record.accessToken.length === 0) {
        throw new PanSyncError("CREDENTIALS_INVALID");
      }
      return record.accessToken;
    }
    this.#assertRefreshEligible(record);

    return this.#singleFlightRefresh(record, expectedAccessToken, options);
  }

  async status(): Promise<TokenManagerStatus> {
    return this.statusForSnapshot(await this.#store.read());
  }

  statusForSnapshot(
    record: CredentialRecord | undefined,
  ): TokenManagerStatus {
    return record?.refreshState.status ?? "unconfigured";
  }

  clearSnapshots(): void {
    const operation = this.#refreshInFlight;
    if (operation === undefined) {
      return;
    }
    if (operation.phase === "committing") {
      return;
    }
    this.#refreshInFlight = undefined;
    this.#settleRefresh(operation, {
      status: "rejected",
      reason: cancellationError(),
    });
    operation.controller.abort();
  }

  async #readConfiguredRecord(): Promise<CredentialRecord> {
    const record = await this.#store.read();
    if (record === undefined) {
      throw new PanSyncError("CREDENTIALS_REQUIRED");
    }
    return record;
  }

  #singleFlightRefresh(
    record: CredentialRecord,
    expectedAccessToken: string | undefined,
    options: ProviderOperationOptions,
  ): Promise<string> {
    if (options.signal?.aborted === true) {
      return Promise.reject(cancellationError());
    }

    let operation = this.#refreshInFlight;
    if (operation === undefined) {
      const created: RefreshOperation = {
        controller: new AbortController(),
        subscribers: new Set(),
        phase: "refreshing",
      };
      operation = created;
      this.#refreshInFlight = created;
      void this.#refresh(
        record,
        expectedAccessToken,
        { signal: created.controller.signal },
        () => this.#beginCommit(created),
      ).then(
        (value) => this.#settleRefresh(created, {
          status: "fulfilled",
          value,
        }),
        (reason: unknown) => this.#settleRefresh(created, {
          status: "rejected",
          reason,
        }),
      );
    }

    return this.#subscribe(operation, options.signal);
  }

  #subscribe(
    operation: RefreshOperation,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const subscriber: RefreshSubscriber = {
        signal,
        onAbort: undefined,
        resolve,
        reject,
      };
      const onAbort = (): void => {
        if (!operation.subscribers.delete(subscriber)) {
          return;
        }
        signal?.removeEventListener("abort", onAbort);
        subscriber.onAbort = undefined;
        reject(cancellationError());
        if (
          operation.subscribers.size === 0
          && this.#refreshInFlight === operation
        ) {
          this.#refreshInFlight = undefined;
          operation.controller.abort();
        }
      };
      subscriber.onAbort = onAbort;
      operation.subscribers.add(subscriber);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
    });
  }

  #settleRefresh(
    operation: RefreshOperation,
    outcome: RefreshOutcome,
  ): void {
    if (this.#refreshInFlight === operation) {
      this.#refreshInFlight = undefined;
    }
    const subscribers = [...operation.subscribers];
    operation.subscribers.clear();
    for (const subscriber of subscribers) {
      if (subscriber.onAbort !== undefined) {
        subscriber.signal?.removeEventListener("abort", subscriber.onAbort);
        subscriber.onAbort = undefined;
      }
      if (outcome.status === "fulfilled") {
        subscriber.resolve(outcome.value);
      } else {
        subscriber.reject(outcome.reason);
      }
    }
  }

  #beginCommit(operation: RefreshOperation): void {
    if (operation.phase === "committing") {
      return;
    }
    operation.phase = "committing";
    for (const subscriber of operation.subscribers) {
      if (subscriber.onAbort !== undefined) {
        subscriber.signal?.removeEventListener("abort", subscriber.onAbort);
        subscriber.onAbort = undefined;
      }
    }
  }

  async #refresh(
    initialRecord: CredentialRecord,
    expectedAccessToken: string | undefined,
    options: ProviderOperationOptions,
    beginCommit: () => void,
  ): Promise<string> {
    try {
      return await this.#runWithRefreshLease(
        REFRESH_LEASE_KEY,
        async (lease) => {
          await lease.assertOwned();
          const record = await this.#readConfiguredRecord();
          await lease.assertOwned();
          if (
            expectedAccessToken !== undefined
            && record.accessToken !== expectedAccessToken
          ) {
            return this.#readyAccessToken(record);
          }
          if (
            expectedAccessToken === undefined
            && record.credentialVersion !== initialRecord.credentialVersion
          ) {
            return this.#winnerAccessToken(record);
          }
          this.#assertRefreshEligible(record);
          if (
            record.refreshApiUrl.length === 0
            || record.refreshToken.length === 0
          ) {
            throw new PanSyncError("CREDENTIALS_INVALID");
          }

          let result: Awaited<ReturnType<AliyunTokenService["refresh"]>>;
          try {
            result = await this.#tokenService.refresh({
              refreshApiUrl: record.refreshApiUrl,
              refreshToken: record.refreshToken,
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
            });
          } catch (error) {
            if (cancellationRequested(options.signal)) {
              throw cancellationError();
            }
            beginCommit();
            const failure = error instanceof PanSyncError
              ? error
              : new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
            const candidate: CredentialRecord = {
              ...record,
              credentialVersion: record.credentialVersion + 1,
              refreshState: this.#refreshFailureState(failure),
            };
            await lease.assertOwned();
            const replaced = await this.#store.replaceIfVersion(
              record.credentialVersion,
              candidate,
              options,
            );
            if (replaced) {
              throw failure;
            }
            return this.#winnerAccessToken(
              await this.#readConfiguredRecord(),
            );
          }

          if (cancellationRequested(options.signal)) {
            throw cancellationError();
          }
          beginCommit();

          const candidate: CredentialRecord = {
            ...record,
            credentialVersion: record.credentialVersion + 1,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            lastVerifiedAt: new Date(this.#clock()).toISOString(),
            refreshState: { status: "ready" },
          };
          await lease.assertOwned();
          const replaced = await this.#store.replaceIfVersion(
            record.credentialVersion,
            candidate,
            options,
          );
          if (replaced) {
            return result.accessToken;
          }
          return this.#winnerAccessToken(await this.#readConfiguredRecord());
        },
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch (error) {
      if (error instanceof PanSyncError) {
        throw error;
      }
      throw cancellationError();
    }
  }

  #assertRefreshEligible(record: CredentialRecord): void {
    const state = record.refreshState;
    if (state.status === "ready") {
      return;
    }
    const failure = new PanSyncError(
      state.failureCode ?? "CREDENTIALS_INVALID",
    );
    if (state.status === "reauth_required") {
      throw failure;
    }
    const notBefore = state.notBefore === undefined
      ? Number.NaN
      : Date.parse(state.notBefore);
    if (!Number.isFinite(notBefore) || this.#clock() < notBefore) {
      throw failure;
    }
  }

  #refreshFailureState(error: PanSyncError): RefreshState {
    if (error.code === "RATE_LIMITED") {
      return {
        status: "rate_limited",
        notBefore: cooldownNotBefore(
          this.#clock(),
          error.retryAfterMs,
          RATE_LIMIT_FALLBACK_MS,
        ),
        failureCode: "RATE_LIMITED",
      };
    }
    if (error.code === "REFRESH_TOKEN_REJECTED") {
      return {
        status: "reauth_required",
        failureCode: "REFRESH_TOKEN_REJECTED",
      };
    }
    return {
      status: "degraded",
      notBefore: cooldownNotBefore(
        this.#clock(),
        TRANSIENT_FAILURE_COOLDOWN_MS,
        TRANSIENT_FAILURE_COOLDOWN_MS,
      ),
      failureCode: "TOKEN_ENDPOINT_UNAVAILABLE",
    };
  }

  #readyAccessToken(record: CredentialRecord): string {
    if (record.refreshState.status !== "ready") {
      throw new PanSyncError(
        record.refreshState.failureCode ?? "CREDENTIALS_INVALID",
      );
    }
    if (record.accessToken.length === 0) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }
    return record.accessToken;
  }

  #winnerAccessToken(record: CredentialRecord): string {
    return this.#readyAccessToken(record);
  }
}
