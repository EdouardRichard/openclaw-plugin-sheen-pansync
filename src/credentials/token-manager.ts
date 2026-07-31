import { PanSyncError } from "../errors.js";
import type { AliyunHttpClient } from "../providers/aliyun/http.js";
import type { ProviderOperationOptions } from "../contracts.js";
import type { CredentialRecord } from "./types.js";

const REFRESH_WINDOW_MS = 5 * 60 * 1_000;

export type TokenManagerStatus =
  | "unconfigured"
  | "ready"
  | "degraded"
  | "reauth_required";

export interface TokenCredentialVault {
  read(): Promise<CredentialRecord | undefined>;
  replaceIfVersion(
    expected: number | undefined,
    candidate: CredentialRecord,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
}

type FailureState = {
  credentialVersion: number;
  status: "degraded" | "reauth_required";
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
  #refreshInFlight: RefreshOperation | undefined;
  #failureState: FailureState | undefined;

  constructor(
    private readonly store: TokenCredentialVault,
    private readonly aliyun: Pick<AliyunHttpClient, "refreshToken">,
    private readonly clock: () => number = Date.now,
  ) {}

  async getValidAccessToken(options: ProviderOperationOptions = {}): Promise<string> {
    const record = await this.#readConfiguredRecord();
    if (
      record.accessToken.length > 0
      && Date.parse(record.accessTokenExpiresAt) - this.clock()
        >= REFRESH_WINDOW_MS
    ) {
      return record.accessToken;
    }

    return this.#singleFlightRefresh(record, options);
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
    const record = await this.store.read();
    if (record === undefined) {
      this.#failureState = undefined;
      return "unconfigured";
    }
    if (
      this.#failureState !== undefined
      && this.#failureState.credentialVersion === record.credentialVersion
    ) {
      return this.#failureState.status;
    }

    this.#failureState = undefined;
    return "ready";
  }

  async #readConfiguredRecord(): Promise<CredentialRecord> {
    const record = await this.store.read();
    if (record === undefined) {
      this.#failureState = undefined;
      throw new PanSyncError("CREDENTIALS_REQUIRED");
    }
    if (
      this.#failureState !== undefined
      && this.#failureState.credentialVersion !== record.credentialVersion
    ) {
      this.#failureState = undefined;
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
      record.clientId.length === 0
      || record.clientSecret.length === 0
      || record.refreshToken.length === 0
    ) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }

    let result: Awaited<ReturnType<AliyunHttpClient["refreshToken"]>>;
    try {
      result = await this.aliyun.refreshToken({
        clientId: record.clientId,
        clientSecret: record.clientSecret,
        refreshToken: record.refreshToken,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error instanceof PanSyncError ? error : cancellationError();
      }
      if (
        error instanceof PanSyncError
        && error.code === "REFRESH_TOKEN_REJECTED"
      ) {
        this.#failureState = {
          credentialVersion: record.credentialVersion,
          status: "reauth_required",
        };
        throw error;
      }
      if (
        error instanceof PanSyncError
        && (error.code === "TOKEN_ENDPOINT_UNAVAILABLE"
          || error.code === "RATE_LIMITED")
      ) {
        this.#failureState = {
          credentialVersion: record.credentialVersion,
          status: "degraded",
        };
        throw error;
      }

      this.#failureState = {
        credentialVersion: record.credentialVersion,
        status: "degraded",
      };
      throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
    }

    const now = this.clock();
    const candidate: CredentialRecord = {
      ...record,
      credentialVersion: record.credentialVersion + 1,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessTokenExpiresAt: new Date(
        now + result.expiresInSeconds * 1_000,
      ).toISOString(),
      lastVerifiedAt: new Date(now).toISOString(),
    };
    const replaced = await this.store.replaceIfVersion(
      record.credentialVersion,
      candidate,
      options,
    );
    if (replaced) {
      this.#failureState = undefined;
      return result.accessToken;
    }

    const winner = await this.store.read();
    if (winner === undefined) {
      this.#failureState = undefined;
      throw new PanSyncError("CREDENTIALS_REQUIRED");
    }
    if (winner.accessToken.length === 0) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }

    this.#failureState = undefined;
    return winner.accessToken;
  }
}
