import { PanSyncError } from "../errors.js";

type Waiter = {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export class FifoDownloadGate {
  readonly #capacity: number;
  readonly #queue: Waiter[] = [];
  #active = 0;

  constructor(capacity = 3) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Download gate capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      return Promise.reject(new PanSyncError("DOWNLOAD_FAILED"));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
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
          reject(new PanSyncError("DOWNLOAD_FAILED"));
          this.#drain();
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#capacity && this.#queue.length > 0) {
      const waiter = this.#queue.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abortListener!);
      this.#active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.#active -= 1;
        this.#drain();
      });
    }
  }
}
