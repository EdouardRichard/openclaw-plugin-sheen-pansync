import { PanSyncError } from "../../errors.js";

export const DOWNLOAD_START_LIMIT = 2;
export const DOWNLOAD_START_WINDOW_MS = 60_000;
export const DOWNLOAD_START_GUARD_MS = 250;
export const DOWNLOAD_START_MAX_WAIT_MS = 60_250;

export type DownloadStartReservation =
  | { status: "granted" }
  | { status: "wait"; waitMs: number };

export type DownloadStartReservationStore = {
  reserve(nowMs: number, signal?: AbortSignal): Promise<DownloadStartReservation>;
};

export type DownloadStartDelay = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => reject(new Error("aborted")));

    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => settle(resolve), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AliyunDownloadStartLimiter {
  readonly #store: DownloadStartReservationStore;
  readonly #clock: () => number;
  readonly #delay: DownloadStartDelay;

  constructor(options: {
    store: DownloadStartReservationStore;
    clock?: () => number;
    delay?: DownloadStartDelay;
  }) {
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
    this.#delay = options.delay ?? defaultDelay;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    try {
      for (;;) {
        if (signal?.aborted === true) throw new PanSyncError("DOWNLOAD_FAILED");
        const reservation = await this.#store.reserve(this.#clock(), signal);
        if (reservation.status === "granted") return;
        if (
          !Number.isFinite(reservation.waitMs)
          || reservation.waitMs < 0
          || reservation.waitMs > DOWNLOAD_START_MAX_WAIT_MS
        ) {
          throw new PanSyncError("DOWNLOAD_FAILED");
        }
        await this.#delay(Math.max(1, Math.ceil(reservation.waitMs)), signal);
      }
    } catch {
      throw new PanSyncError("DOWNLOAD_FAILED");
    }
  }
}
