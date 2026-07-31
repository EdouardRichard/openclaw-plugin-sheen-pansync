const { createFilesystemCredentialLeaseRunner } = await import(
  process.env.PAN_SYNC_LEASE_MODULE_URL
);

const send = (message) => {
  if (process.connected) process.send(message);
};

let release;
const released = new Promise((resolve) => {
  release = resolve;
});

process.on("message", (message) => {
  if (message?.type === "release") release();
});

let contentionReported = false;
const runner = createFilesystemCredentialLeaseRunner(
  process.env.PAN_SYNC_LOCK_DIR,
  {
    heartbeatMs: Number(process.env.PAN_SYNC_HEARTBEAT_MS),
    staleMs: Number(process.env.PAN_SYNC_STALE_MS),
    retryMs: Number(process.env.PAN_SYNC_RETRY_MS),
    waitTimeoutMs: Number(process.env.PAN_SYNC_WAIT_TIMEOUT_MS),
    onContention() {
      if (contentionReported) return;
      contentionReported = true;
      send({ type: "contention", pid: process.pid });
    },
  },
);

try {
  await runner("credentials", async ({ assertOwned }) => {
    send({ type: "entered", pid: process.pid });
    await released;
    await assertOwned();
  });
  send({ type: "done", pid: process.pid });
  process.disconnect();
} catch (error) {
  send({
    type: "error",
    pid: process.pid,
    message: error instanceof Error ? error.message : "unknown",
  });
  process.exitCode = 1;
  process.disconnect();
}
