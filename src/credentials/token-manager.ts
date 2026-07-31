import { PanSyncError } from "../errors.js";
import type { AliyunHttpClient } from "../providers/aliyun/http.js";
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

export class TokenManager {
  #refreshInFlight: Promise<string> | undefined;
  #failureState: FailureState | undefined;

  constructor(
    private readonly store: TokenCredentialVault,
    private readonly aliyun: Pick<AliyunHttpClient, "refreshToken">,
    private readonly clock: () => number = Date.now,
  ) {}

  async getValidAccessToken(): Promise<string> {
    const record = await this.#readConfiguredRecord();
    if (
      record.accessToken.length > 0
      && Date.parse(record.accessTokenExpiresAt) - this.clock()
        >= REFRESH_WINDOW_MS
    ) {
      return record.accessToken;
    }

    return this.#singleFlightRefresh(record);
  }

  async forceRefresh(expectedAccessToken?: string): Promise<string> {
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

    return this.#singleFlightRefresh(record);
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

  #singleFlightRefresh(record: CredentialRecord): Promise<string> {
    if (this.#refreshInFlight !== undefined) {
      return this.#refreshInFlight;
    }

    const refresh = this.#refresh(record);
    const tracked = refresh.finally(() => {
      if (this.#refreshInFlight === tracked) {
        this.#refreshInFlight = undefined;
      }
    });
    this.#refreshInFlight = tracked;
    return tracked;
  }

  async #refresh(record: CredentialRecord): Promise<string> {
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
      });
    } catch (error) {
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
