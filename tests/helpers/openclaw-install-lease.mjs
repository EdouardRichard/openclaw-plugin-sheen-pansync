import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ACQUISITION_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 25;

export function openClawInstallLockDirectory(parentPid = process.ppid) {
  return path.join(
    tmpdir(),
    `pan-sync-openclaw-install-${parentPid}.lock`,
  );
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function acquire(lockDirectory) {
  // The namespace belongs to one Vitest coordinator. We deliberately do not
  // steal an existing directory within that run: a killed holder means the
  // run is unhealthy, and deleting a lock without ownership proof could admit
  // a second installer while the first is still alive.
  const deadline = Date.now() + ACQUISITION_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDirectory);
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

export async function withOpenClawInstallLease(run) {
  const lockDirectory = openClawInstallLockDirectory();
  await acquire(lockDirectory);
  try {
    return await run();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}
