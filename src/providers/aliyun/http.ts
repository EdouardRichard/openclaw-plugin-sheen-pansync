import { PanSyncError } from "../../errors.js";
import type {
  AliyunHttpClientOptions,
  AliyunRefreshTokenInput,
  AliyunRefreshTokenResult,
  AliyunTimeoutHandle,
} from "./types.js";

export const ALIYUN_OPENAPI_BASE_URL = "https://openapi.alipan.com";

const TOKEN_ENDPOINT_PATH = "/oauth/access_token";
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInvalidGrant(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }

  const error = body.error ?? body.code;
  return (
    typeof error === "string"
    && error.toLowerCase() === "invalid_grant"
  );
}

function parseTokenResult(body: unknown): AliyunRefreshTokenResult {
  if (!isRecord(body)) {
    throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
  }

  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  const expiresInSeconds = body.expires_in;
  if (
    typeof accessToken !== "string"
    || accessToken.length === 0
    || typeof refreshToken !== "string"
    || refreshToken.length === 0
    || typeof expiresInSeconds !== "number"
    || !Number.isFinite(expiresInSeconds)
    || expiresInSeconds <= 0
  ) {
    throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
  }

  return {
    accessToken,
    refreshToken,
    expiresInSeconds,
  };
}

export class AliyunHttpClient {
  readonly #baseUrl: string;
  readonly #fetch: NonNullable<AliyunHttpClientOptions["fetch"]>;
  readonly #clock: () => number;
  readonly #scheduleTimeout: NonNullable<
    AliyunHttpClientOptions["scheduleTimeout"]
  >;
  readonly #cancelTimeout: NonNullable<
    AliyunHttpClientOptions["cancelTimeout"]
  >;

  constructor(options: AliyunHttpClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? ALIYUN_OPENAPI_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
    this.#scheduleTimeout = options.scheduleTimeout ?? setTimeout;
    this.#cancelTimeout = options.cancelTimeout ?? clearTimeout;
  }

  async refreshToken(
    input: AliyunRefreshTokenInput,
  ): Promise<AliyunRefreshTokenResult> {
    const controller = new AbortController();
    const deadline = this.#clock() + TOKEN_REQUEST_TIMEOUT_MS;
    let timeout: AliyunTimeoutHandle | undefined;
    const abortFromInput = () => controller.abort(input.signal?.reason);

    if (input.signal?.aborted === true) {
      abortFromInput();
    } else {
      input.signal?.addEventListener("abort", abortFromInput, { once: true });
    }

    try {
      timeout = this.#scheduleTimeout(
        () => controller.abort(),
        Math.max(0, deadline - this.#clock()),
      );
      const response = await this.#fetch(
        new URL(TOKEN_ENDPOINT_PATH, this.#baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            grant_type: "refresh_token",
            refresh_token: input.refreshToken,
          }),
          signal: controller.signal,
        },
      );
      const body: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        if (isInvalidGrant(body)) {
          throw new PanSyncError("REFRESH_TOKEN_REJECTED");
        }
        if (response.status === 429) {
          throw new PanSyncError("RATE_LIMITED");
        }
        if (response.status === 502 || response.status === 503) {
          throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
        }
        throw new PanSyncError("CREDENTIALS_INVALID");
      }

      return parseTokenResult(body);
    } catch (error) {
      if (error instanceof PanSyncError) {
        throw error;
      }
      throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
    } finally {
      if (timeout !== undefined) {
        this.#cancelTimeout(timeout);
      }
      input.signal?.removeEventListener("abort", abortFromInput);
    }
  }
}
