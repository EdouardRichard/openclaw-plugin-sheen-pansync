import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openClawInstallLockDirectory } from "../helpers/openclaw-install-lease.mjs";

type AuditEvent = { type: "enter" | "exit"; pid: number };

const childScript = fileURLToPath(
  new URL("../helpers/openclaw-install-lease-child.mjs", import.meta.url),
);

function runChild(auditPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, auditPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("install lease child timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new Error(
          `install lease child failed: code=${code}; signal=${signal}; stderr=${stderr}`,
        ));
      }
    });
  });
}

describe("OpenClaw install lease process boundary", () => {
  it("serializes independent Node processes with one parent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pan-sync-install-lease-process-"));
    const auditPath = path.join(root, "audit.jsonl");
    const lockDirectory = openClawInstallLockDirectory(process.pid);

    try {
      await Promise.all(Array.from({ length: 3 }, () => runChild(auditPath)));
      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as AuditEvent);
      let active = 0;
      let maximumActive = 0;
      for (const event of events) {
        active += event.type === "enter" ? 1 : -1;
        maximumActive = Math.max(maximumActive, active);
        expect(active).toBeGreaterThanOrEqual(0);
      }

      expect(new Set(events.map(({ pid }) => pid)).size).toBe(3);
      expect(maximumActive).toBe(1);
      expect(active).toBe(0);
      await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
