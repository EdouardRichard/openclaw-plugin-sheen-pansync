import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { withOpenClawInstallLease } from "./openclaw-install-lease.mjs";

const auditPath = process.argv[2];
if (auditPath === undefined) throw new Error("audit path required");

await withOpenClawInstallLease(async () => {
  await appendFile(
    auditPath,
    `${JSON.stringify({ type: "enter", pid: process.pid })}\n`,
    "utf8",
  );
  await delay(150);
  await appendFile(
    auditPath,
    `${JSON.stringify({ type: "exit", pid: process.pid })}\n`,
    "utf8",
  );
});
