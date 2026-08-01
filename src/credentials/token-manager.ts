import type { ProviderOperationOptions } from "../contracts.js";
import { PanSyncError } from "../errors.js";
import type { AliyunTokenService } from "../providers/aliyun/types.js";
import type { CredentialRecord } from "./types.js";

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
  clock?: () => number;
};

type RefreshSubscriber = {
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  resolve(token: string): void;
  reject(error: unknown): void;
};

type RefreshOperation = {
  controller: AbortController;
  subscribers: Set<RefreshSubscriber>;
};

type RefreshOutcome =
  | { status: "fulfilled"; value: string }
  | { status: "rejected"; reason: unknown };

function cancellationError(): PanSyncError {
  return new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
}

export class TokenManager {
  readonly #store: TokenCredentialVault;
  readonly #tokenService: AliyunTokenService;
  readonly #clock: () => number;
  #refreshInFlight: RefreshOperation | undefined;

  constructor(options: TokenManagerOptions) {
    this.#store = options.store;
    this.#tokenService = options.tokenService;
    this.#clock = options.clock ?? Date.now;
  }

  async getValidAccessToken(
    _options: ProviderOperationOptions = {},
  ): Promise<string> {
    const record = await this.#readConfiguredRecord();
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

    return this.#singleFlightRefresh(record, options);
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
      };
      operation = created;
      this.#refreshInFlight = created;
      void this.#refresh(record, { signal: created.controller.signal }).then(
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

  async #refresh(
    record: CredentialRecord,
    options: ProviderOperationOptions,
  ): Promise<string> {
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
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof PanSyncError) {
        throw error;
      }
      throw cancellationError();
    }

    const candidate: CredentialRecord = {
      ...record,
      credentialVersion: record.credentialVersion + 1,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      lastVerifiedAt: new Date(this.#clock()).toISOString(),
      refreshState: { status: "ready" },
    };
    const replaced = await this.#store.replaceIfVersion(
      record.credentialVersion,
      candidate,
      options,
    );
    if (replaced) {
      return result.accessToken;
    }

    const winner = await this.#store.read();
    if (winner === undefined) {
      throw new PanSyncError("CREDENTIALS_REQUIRED");
    }
    if (winner.accessToken.length === 0) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }
    return winner.accessToken;
  }
}
