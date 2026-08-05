import { PanSyncError } from "../errors.js";

type Waiter = {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export class FifoUploadGate {
  readonly #queue: Waiter[] = [];
  #active = false;

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      return Promise.reject(new PanSyncError("UPLOAD_FAILED"));
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
          reject(new PanSyncError("UPLOAD_FAILED"));
          this.#drain();
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#active || this.#queue.length === 0) {
      return;
    }
    const waiter = this.#queue.shift()!;
    waiter.signal?.removeEventListener("abort", waiter.abortListener!);
    this.#active = true;
    let released = false;
    waiter.resolve(() => {
      if (released) {
        return;
      }
      released = true;
      this.#active = false;
      this.#drain();
    });
  }
}
