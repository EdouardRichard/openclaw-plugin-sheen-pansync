import { PanSyncError } from "../../errors.js";
import type {
  AliyunFetch,
  AliyunTokenService,
  OpenListRefreshInput,
  OpenListRefreshResult,
} from "./types.js";

export const DEFAULT_OPENLIST_AUTHORIZATION_PAGE_URL = "https://api.oplist.org.cn";
export const DEFAULT_OPENLIST_REFRESH_API_URL = "https://api.oplist.org.cn/alicloud/renewapi";

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now) {
    return undefined;
  }
  return timestamp - now;
}

export class OpenListTokenService implements AliyunTokenService {
  readonly #fetch: AliyunFetch;
  readonly #clock: () => number;
  readonly #scheduleTimeout: typeof setTimeout;
  readonly #cancelTimeout: typeof clearTimeout;

  constructor(options: {
    fetch?: AliyunFetch;
    clock?: () => number;
    scheduleTimeout?: typeof setTimeout;
    cancelTimeout?: typeof clearTimeout;
  } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
    this.#scheduleTimeout = options.scheduleTimeout ?? setTimeout;
    this.#cancelTimeout = options.cancelTimeout ?? clearTimeout;
  }

  async refresh(input: OpenListRefreshInput): Promise<OpenListRefreshResult> {
    const controller = new AbortController();
    const deadline = this.#clock() + TOKEN_REQUEST_TIMEOUT_MS;
    const abortFromInput = () => controller.abort(input.signal?.reason);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (input.signal?.aborted === true) {
      abortFromInput();
    } else {
      input.signal?.addEventListener("abort", abortFromInput, { once: true });
    }

    try {
      const url = new URL(input.refreshApiUrl);
      url.searchParams.set("refresh_ui", input.refreshToken);
      url.searchParams.set("server_use", "true");
      url.searchParams.set("driver_txt", "alicloud_qr");
      timeout = this.#scheduleTimeout(
        () => controller.abort(),
        Math.max(0, deadline - this.#clock()),
      );
      const response = await this.#fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
          this.#clock(),
        );
        throw new PanSyncError(
          "RATE_LIMITED",
          retryAfterMs === undefined ? {} : { retryAfterMs },
        );
      }
      if (response.status >= 500) {
        throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
      }
      if (!response.ok) {
        throw new PanSyncError("REFRESH_TOKEN_REJECTED");
      }

      const body: unknown = await response.json().catch(() => undefined);
      if (!isRecord(body)
        || !isNonEmptyString(body.access_token)
        || !isNonEmptyString(body.refresh_token)) {
        throw new PanSyncError("REFRESH_TOKEN_REJECTED");
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
      };
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
