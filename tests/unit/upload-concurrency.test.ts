import { describe, expect, it } from "vitest";
import { FifoUploadGate } from "../../src/upload/upload-concurrency.js";

describe("FifoUploadGate", () => {
  it("admits one upload and releases queued callers in FIFO order", async () => {
    const gate = new FifoUploadGate();
    const order: number[] = [];
    const pending = [1, 2, 3].map((value) =>
      gate.acquire().then((release) => {
        order.push(value);
        return release;
      })
    );

    await Promise.resolve();
    expect(order).toEqual([1]);

    for (let completed = 1; completed <= pending.length; completed += 1) {
      const release = await pending[completed - 1]!;
      release();
      await Promise.resolve();
      expect(order).toEqual(
        Array.from({ length: Math.min(completed + 1, pending.length) },
          (_unused, index) => index + 1),
      );
    }
  });

  it("removes an aborted queued caller without admitting it", async () => {
    const gate = new FifoUploadGate();
    const releaseFirst = await gate.acquire();
    const controller = new AbortController();
    const aborted = gate.acquire(controller.signal);

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    releaseFirst();
  });
});
