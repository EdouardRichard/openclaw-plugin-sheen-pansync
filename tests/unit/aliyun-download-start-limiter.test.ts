import { describe, expect, it, vi } from "vitest";
import { AliyunDownloadStartLimiter } from "../../src/providers/aliyun/download-start-limiter.js";

describe("AliyunDownloadStartLimiter", () => {
  it("completes immediately when the reservation is granted", async () => {
    const reserve = vi.fn().mockResolvedValue({ status: "granted" });
    const delay = vi.fn(async () => undefined);
    const limiter = new AliyunDownloadStartLimiter({
      store: { reserve },
      clock: () => 1_000,
      delay,
    });

    await expect(limiter.acquire()).resolves.toBeUndefined();
    expect(reserve).toHaveBeenCalledWith(1_000, undefined);
    expect(delay).not.toHaveBeenCalled();
  });

  it("rechecks after every instructed wait until the reservation is granted", async () => {
    const reserve = vi.fn()
      .mockResolvedValueOnce({ status: "wait", waitMs: 42_000 })
      .mockResolvedValueOnce({ status: "wait", waitMs: 0.2 })
      .mockResolvedValueOnce({ status: "granted" });
    const delay = vi.fn(async () => undefined);
    const limiter = new AliyunDownloadStartLimiter({
      store: { reserve },
      clock: () => 1_000,
      delay,
    });

    await limiter.acquire();

    expect(delay).toHaveBeenNthCalledWith(1, 42_000, undefined);
    expect(delay).toHaveBeenNthCalledWith(2, 1, undefined);
    expect(reserve).toHaveBeenNthCalledWith(1, 1_000, undefined);
    expect(reserve).toHaveBeenCalledTimes(3);
  });

  it("rejects an already-aborted acquisition before reserving", async () => {
    const controller = new AbortController();
    controller.abort();
    const reserve = vi.fn().mockResolvedValue({ status: "granted" });
    const limiter = new AliyunDownloadStartLimiter({ store: { reserve } });

    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: "DOWNLOAD_FAILED",
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("converts cancellation during a local wait into a download failure", async () => {
    const controller = new AbortController();
    const reserve = vi.fn().mockResolvedValue({ status: "wait", waitMs: 1 });
    const delay = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      controller.abort();
      if (signal?.aborted === true) throw new Error("aborted");
    });
    const limiter = new AliyunDownloadStartLimiter({
      store: { reserve },
      delay,
    });

    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: "DOWNLOAD_FAILED",
    });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("hides store rejections behind a download failure", async () => {
    const limiter = new AliyunDownloadStartLimiter({
      store: { reserve: vi.fn().mockRejectedValue(new Error("database unavailable")) },
    });

    await expect(limiter.acquire()).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: "DOWNLOAD_FAILED",
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects an invalid wait value of %s",
    async (waitMs) => {
      const limiter = new AliyunDownloadStartLimiter({
        store: { reserve: vi.fn().mockResolvedValue({ status: "wait", waitMs }) },
      });

      await expect(limiter.acquire()).rejects.toMatchObject({
        code: "DOWNLOAD_FAILED",
        message: "DOWNLOAD_FAILED",
      });
    },
  );

  it("rejects a wait above the maximum download-start window", async () => {
    const limiter = new AliyunDownloadStartLimiter({
      store: { reserve: vi.fn().mockResolvedValue({ status: "wait", waitMs: 60_251 }) },
    });

    await expect(limiter.acquire()).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: "DOWNLOAD_FAILED",
    });
  });
});
