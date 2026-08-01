import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ACQUISITION_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 25;
const LOCK_DIRECTORY = path.join(
  tmpdir(),
  `pan-sync-openclaw-install-${process.ppid}.lock`,
);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function acquire(): Promise<void> {
  const deadline = Date.now() + ACQUISITION_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(LOCK_DIRECTORY);
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("OpenClaw integration install lease timed out");
      }
      await delay(POLL_INTERVAL_MS);
    }
  }
}

export async function withOpenClawInstallLease<T>(
  run: () => T | Promise<T>,
): Promise<T> {
  await acquire();
  try {
    return await run();
  } finally {
    await rm(LOCK_DIRECTORY, { recursive: true, force: true });
  }
}
