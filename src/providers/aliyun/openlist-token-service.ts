import { PanSyncError } from "../../errors.js";
import type {
  AliyunFetch,
  AliyunTokenService,
  OpenListRefreshInput,
  OpenListRefreshResult,
} from "./types.js";

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
const OBSOLETE_WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function httpDateTimestamp(
  weekday: string,
  day: string,
  month: string,
  year: string,
  hour: string,
  minute: string,
  second: string,
): number | undefined {
  const weekdayIndex = WEEKDAYS.indexOf(weekday as typeof WEEKDAYS[number]);
  const monthIndex = MONTHS.indexOf(month as typeof MONTHS[number]);
  const numeric = [day, year, hour, minute, second].map(Number);
  const [numericDay, numericYear, numericHour, numericMinute, numericSecond] = numeric;
  if (
    weekdayIndex < 0
    || monthIndex < 0
    || numericDay === undefined
    || numericYear === undefined
    || numericHour === undefined
    || numericMinute === undefined
    || numericSecond === undefined
    || numericDay < 1
    || numericHour > 23
    || numericMinute > 59
    || numericSecond > 59
  ) {
    return undefined;
  }

  const timestamp = Date.UTC(
    numericYear,
    monthIndex,
    numericDay,
    numericHour,
    numericMinute,
    numericSecond,
  );
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== numericYear
    || parsed.getUTCMonth() !== monthIndex
    || parsed.getUTCDate() !== numericDay
    || parsed.getUTCDay() !== weekdayIndex
  ) {
    return undefined;
  }
  return timestamp;
}

function parseHttpDate(value: string, now: number): number | undefined {
  const imfFixdate = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (imfFixdate !== null) {
    return httpDateTimestamp(
      imfFixdate[1] ?? "",
      imfFixdate[2] ?? "",
      imfFixdate[3] ?? "",
      imfFixdate[4] ?? "",
      imfFixdate[5] ?? "",
      imfFixdate[6] ?? "",
      imfFixdate[7] ?? "",
    );
  }

  const rfc850Date = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (rfc850Date !== null) {
    const weekday = rfc850Date[1] ?? "";
    const weekdayIndex = OBSOLETE_WEEKDAYS.indexOf(
      weekday as typeof OBSOLETE_WEEKDAYS[number],
    );
    const yearSuffix = Number(rfc850Date[4]);
    const currentYear = new Date(now).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + yearSuffix;
    if (year > currentYear + 50) {
      year -= 100;
    }
    return httpDateTimestamp(
      WEEKDAYS[weekdayIndex] ?? "",
      rfc850Date[2] ?? "",
      rfc850Date[3] ?? "",
      String(year),
      rfc850Date[5] ?? "",
      rfc850Date[6] ?? "",
      rfc850Date[7] ?? "",
    );
  }

  const asctimeDate = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (asctimeDate !== null) {
    return httpDateTimestamp(
      asctimeDate[1] ?? "",
      asctimeDate[3] ?? "",
      asctimeDate[2] ?? "",
      asctimeDate[7] ?? "",
      asctimeDate[4] ?? "",
      asctimeDate[5] ?? "",
      asctimeDate[6] ?? "",
    );
  }

  return undefined;
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
    if (!Number.isSafeInteger(seconds)) {
      return undefined;
    }
    const milliseconds = seconds * 1_000;
    const notBefore = now + milliseconds;
    return Number.isSafeInteger(milliseconds)
      && Number.isSafeInteger(notBefore)
      && Math.abs(notBefore) <= MAX_DATE_TIMESTAMP_MS
      ? milliseconds
      : undefined;
  }

  const timestamp = parseHttpDate(value, now);
  if (timestamp === undefined || timestamp <= now) {
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
