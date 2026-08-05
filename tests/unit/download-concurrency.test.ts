import { describe, expect, it } from "vitest";
import { FifoDownloadGate } from "../../src/read/download-concurrency.js";

describe("FifoDownloadGate", () => {
  it("admits three downloads and then releases queued callers in FIFO order", async () => {
    const gate = new FifoDownloadGate();
    const releases = await Promise.all([
      gate.acquire(),
      gate.acquire(),
      gate.acquire(),
    ]);
    const order: number[] = [];
    let releaseFourth: (() => void) | undefined;
    let releaseFifth: (() => void) | undefined;
    const fourth = gate.acquire().then((release) => {
      order.push(4);
      releaseFourth = release;
    });
    const fifth = gate.acquire().then((release) => {
      order.push(5);
      releaseFifth = release;
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    releases[0]();
    await fourth;
    expect(order).toEqual([4]);
    releaseFourth!();
    await fifth;
    expect(order).toEqual([4, 5]);

    releases[1]();
    releases[2]();
    releaseFifth!();
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
