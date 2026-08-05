import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AliyunOpenApiRateLimiter } from "../../src/providers/aliyun/rate-limiter.js";

const LIST_ENDPOINT = "/adrive/v1.0/openFile/list";
const DOWNLOAD_URL_ENDPOINT = "/adrive/v1.0/openFile/getDownloadUrl";
const OTHER_ENDPOINT = "/adrive/v1.0/openFile/get";

function acquireMany(
  limiter: AliyunOpenApiRateLimiter,
  count: number,
  endpoint = OTHER_ENDPOINT,
): Promise<void>[] {
  return Array.from({ length: count }, () => limiter.acquire(endpoint));
}

describe("AliyunOpenApiRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the eleventh getDownloadUrl start until its rolling ten-second window opens", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    const firstTen = acquireMany(limiter, 10, DOWNLOAD_URL_ENDPOINT);
    await vi.advanceTimersByTimeAsync(3_150);
    await Promise.all(firstTen);
    let started = false;
    const eleventh = limiter.acquire(DOWNLOAD_URL_ENDPOINT).then(() => {
      started = true;
    });

    await vi.advanceTimersByTimeAsync(6_849);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await eleventh;

    expect(started).toBe(true);
  });

  it("keeps list starts below forty per ten seconds through global pacing", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    const starts: number[] = [];
    const pending = acquireMany(limiter, 30, LIST_ENDPOINT).map((promise) =>
      promise.then(() => starts.push(Date.now()))
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(starts).toHaveLength(29);
    expect(starts.at(-1)).toBe(9_800);
    await vi.advanceTimersByTimeAsync(151);
    await Promise.all(pending);

    expect(starts.at(-1)).toBe(10_150);
  });

  it("paces mixed OpenAPI starts at least 350 ms apart", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    const starts: number[] = [];
    const pending = [
      limiter.acquire(LIST_ENDPOINT),
      limiter.acquire(DOWNLOAD_URL_ENDPOINT),
      limiter.acquire(OTHER_ENDPOINT),
      limiter.acquire(OTHER_ENDPOINT),
    ].map((promise) => promise.then(() => starts.push(Date.now())));

    await vi.advanceTimersByTimeAsync(1_049);
    expect(starts).toEqual([0, 350, 700]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(pending);

    expect(starts).toEqual([0, 350, 700, 1_050]);
  });

  it("admits queued callers in FIFO order", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    const order: number[] = [];
    const queued = [1, 2, 3].map((value) =>
      limiter.acquire(OTHER_ENDPOINT).then(() => order.push(value))
    );

    await vi.advanceTimersByTimeAsync(700);
    await Promise.all(queued);

    expect(order).toEqual([1, 2, 3]);
  });

  it("removes an aborted queued caller without delaying the next caller", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    await limiter.acquire(OTHER_ENDPOINT);
    const controller = new AbortController();
    const aborted = limiter.acquire(OTHER_ENDPOINT, controller.signal);
    let nextStarted = false;
    const next = limiter.acquire(OTHER_ENDPOINT).then(() => {
      nextStarted = true;
    });

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(nextStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(349);
    expect(nextStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await next;

    expect(nextStarted).toBe(true);
  });
});
