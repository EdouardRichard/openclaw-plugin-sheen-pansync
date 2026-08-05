import { describe, expect, it } from "vitest";
import { FifoDownloadGate } from "../../src/read/download-concurrency.js";

describe("FifoDownloadGate", () => {
  it("admits one download and then releases queued callers in FIFO order", async () => {
    const gate = new FifoDownloadGate();
    const order: number[] = [];
    const pending = [1, 2, 3, 4, 5].map((value) =>
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

  it("makes release idempotent without admitting more than one waiter", async () => {
    const gate = new FifoDownloadGate(1);
    const releaseFirst = await gate.acquire();
    let admissions = 0;
    const second = gate.acquire().then((release) => {
      admissions += 1;
      return release;
    });
    const third = gate.acquire().then((release) => {
      admissions += 1;
      return release;
    });

    releaseFirst();
    releaseFirst();
    const releaseSecond = await second;
    expect(admissions).toBe(1);
    releaseSecond();
    const releaseThird = await third;
    expect(admissions).toBe(2);
    releaseThird();
  });

  it("removes an aborted queued caller and admits the next one", async () => {
    const gate = new FifoDownloadGate(1);
    const releaseFirst = await gate.acquire();
    const controller = new AbortController();
    const aborted = gate.acquire(controller.signal);
    let nextAdmitted = false;
    const next = gate.acquire().then((release) => {
      nextAdmitted = true;
      return release;
    });

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(nextAdmitted).toBe(false);
    releaseFirst();
    const releaseNext = await next;
    expect(nextAdmitted).toBe(true);
    releaseNext();
  });

  it("rejects an already-aborted acquisition", async () => {
    const gate = new FifoDownloadGate();
    const controller = new AbortController();
    controller.abort();

    await expect(gate.acquire(controller.signal)).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
    });
  });
});
