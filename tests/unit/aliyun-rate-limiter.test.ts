import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AliyunOpenApiRateLimiter } from "../../src/providers/aliyun/rate-limiter.js";

const LIST_ENDPOINT = "/adrive/v1.0/openFile/list";
const DOWNLOAD_URL_ENDPOINT = "/adrive/v1.0/openFile/getDownloadUrl";
const OTHER_ENDPOINT = "/adrive/v1.0/openFile/get";

async function acquireMany(
  limiter: AliyunOpenApiRateLimiter,
  count: number,
  endpoint = OTHER_ENDPOINT,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, () => limiter.acquire(endpoint)),
  );
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
    await acquireMany(limiter, 10, DOWNLOAD_URL_ENDPOINT);
    let started = false;
    const eleventh = limiter.acquire(DOWNLOAD_URL_ENDPOINT).then(() => {
      started = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await eleventh;

    expect(started).toBe(true);
  });

  it("holds the forty-first list start until its rolling ten-second window opens", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    await acquireMany(limiter, 15, LIST_ENDPOINT);
    await vi.advanceTimersByTimeAsync(1_000);
    await acquireMany(limiter, 15, LIST_ENDPOINT);
    await vi.advanceTimersByTimeAsync(1_000);
    await acquireMany(limiter, 10, LIST_ENDPOINT);
    let started = false;
    const fortyFirst = limiter.acquire(LIST_ENDPOINT).then(() => {
      started = true;
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await fortyFirst;

    expect(started).toBe(true);
  });

  it("applies the conservative fifteen-per-second budget across mixed endpoints", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    await Promise.all([
      ...Array.from({ length: 5 }, () => limiter.acquire(LIST_ENDPOINT)),
      ...Array.from({ length: 5 }, () => limiter.acquire(DOWNLOAD_URL_ENDPOINT)),
      ...Array.from({ length: 5 }, () => limiter.acquire(OTHER_ENDPOINT)),
    ]);
    let started = false;
    const sixteenth = limiter.acquire(LIST_ENDPOINT).then(() => {
      started = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sixteenth;

    expect(started).toBe(true);
  });

  it("admits queued callers in FIFO order", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    await acquireMany(limiter, 15);
    const order: number[] = [];
    const queued = [1, 2, 3].map((value) =>
      limiter.acquire(OTHER_ENDPOINT).then(() => order.push(value))
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(queued);

    expect(order).toEqual([1, 2, 3]);
  });

  it("removes an aborted queued caller without delaying the next caller", async () => {
    const limiter = new AliyunOpenApiRateLimiter();
    await acquireMany(limiter, 15);
    const controller = new AbortController();
    const aborted = limiter.acquire(OTHER_ENDPOINT, controller.signal);
    let nextStarted = false;
    const next = limiter.acquire(OTHER_ENDPOINT).then(() => {
      nextStarted = true;
    });

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(nextStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await next;

    expect(nextStarted).toBe(true);
  });
});
