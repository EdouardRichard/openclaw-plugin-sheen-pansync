type RateLimitRule = {
  limit: number;
  windowMs: number;
};

type Waiter = {
  endpointPath: string;
  resolve(): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export type AliyunOpenApiRateLimiterOptions = {
  clock?: () => number;
};

const GLOBAL_RULE: RateLimitRule = { limit: 15, windowMs: 1_000 };
const GLOBAL_MIN_START_INTERVAL_MS = 350;
const LIST_RULE: RateLimitRule = { limit: 40, windowMs: 10_000 };
const DOWNLOAD_URL_RULE: RateLimitRule = { limit: 10, windowMs: 10_000 };
const LIST_ENDPOINT = "/adrive/v1.0/openFile/list";
const DOWNLOAD_URL_ENDPOINT = "/adrive/v1.0/openFile/getDownloadUrl";

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function prune(
  starts: number[],
  rule: RateLimitRule,
  now: number,
): void {
  const threshold = now - rule.windowMs;
  let expired = 0;
  while (starts[expired] !== undefined && starts[expired]! <= threshold) {
    expired += 1;
  }
  if (expired > 0) {
    starts.splice(0, expired);
  }
}

function requiredWait(
  starts: number[],
  rule: RateLimitRule,
  now: number,
): number {
  prune(starts, rule, now);
  if (starts.length < rule.limit) {
    return 0;
  }
  return Math.max(0, starts[0]! + rule.windowMs - now);
}

export class AliyunOpenApiRateLimiter {
  readonly #clock: () => number;
  readonly #globalStarts: number[] = [];
  readonly #listStarts: number[] = [];
  readonly #downloadUrlStarts: number[] = [];
  readonly #queue: Waiter[] = [];
  #lastGlobalStart: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AliyunOpenApiRateLimiterOptions = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  acquire(endpointPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        endpointPath,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        waiter.abortListener = () => {
          const index = this.#queue.indexOf(waiter);
          if (index === -1) {
            return;
          }
          this.#queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.abortListener!);
          reject(abortError());
          this.#drain();
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    while (this.#queue.length > 0) {
      const waiter = this.#queue[0]!;
      const now = this.#clock();
      const globalIntervalWait = this.#lastGlobalStart === undefined
        ? 0
        : Math.max(
          0,
          this.#lastGlobalStart + GLOBAL_MIN_START_INTERVAL_MS - now,
        );
      const waitMs = Math.max(
        globalIntervalWait,
        requiredWait(this.#globalStarts, GLOBAL_RULE, now),
        waiter.endpointPath === LIST_ENDPOINT
          ? requiredWait(this.#listStarts, LIST_RULE, now)
          : 0,
        waiter.endpointPath === DOWNLOAD_URL_ENDPOINT
          ? requiredWait(this.#downloadUrlStarts, DOWNLOAD_URL_RULE, now)
          : 0,
      );
      if (waitMs > 0) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          this.#drain();
        }, Math.max(1, Math.ceil(waitMs)));
        return;
      }

      this.#queue.shift();
      waiter.signal?.removeEventListener("abort", waiter.abortListener!);
      this.#lastGlobalStart = now;
      this.#globalStarts.push(now);
      if (waiter.endpointPath === LIST_ENDPOINT) {
        this.#listStarts.push(now);
      } else if (waiter.endpointPath === DOWNLOAD_URL_ENDPOINT) {
        this.#downloadUrlStarts.push(now);
      }
      waiter.resolve();
    }
  }
}
