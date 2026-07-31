const { createSqliteWorkerCredentialLeaseRunner } = await import(
  process.env.PAN_SYNC_LEASE_MODULE_URL
);

const send = (message) => {
  if (process.connected) process.send({ ...message, pid: process.pid });
};

const controller = new AbortController();
let releaseCallback;
const callbackReleased = new Promise((resolve) => {
  releaseCallback = resolve;
});
let unwindCallback;
const callbackUnwound = new Promise((resolve) => {
  unwindCallback = resolve;
});
let releaseFirst;
const firstReleased = new Promise((resolve) => {
  releaseFirst = resolve;
});
let releaseSecond;
const secondReleased = new Promise((resolve) => {
  releaseSecond = resolve;
});

process.on("message", (message) => {
  if (message?.type === "release") releaseCallback();
  if (message?.type === "cancel") controller.abort();
  if (message?.type === "unwind") unwindCallback();
  if (message?.type === "release-first") releaseFirst();
  if (message?.type === "release-second") releaseSecond();
});

const ticks = setInterval(() => send({ type: "tick" }), 10);
const runner = createSqliteWorkerCredentialLeaseRunner(
  process.env.PAN_SYNC_LEASE_DATABASE,
);
send({ type: "started" });

try {
  if (process.env.PAN_SYNC_LEASE_MODE === "dual") {
    let firstEntered;
    const firstEntry = new Promise((resolve) => {
      firstEntered = resolve;
    });
    const first = runner("credentials", async (lease) => {
      send({ type: "entered-first" });
      firstEntered();
      await firstReleased;
      await lease.assertOwned();
    });
    await firstEntry;
    const second = runner("credentials", async (lease) => {
      send({ type: "entered-second" });
      await secondReleased;
      await lease.assertOwned();
    });
    await Promise.all([first, second]);
  } else {
    await runner("credentials", async (lease) => {
      send({ type: "entered" });
      if (process.env.PAN_SYNC_LEASE_MODE === "abortable") {
        if (!controller.signal.aborted) {
          await new Promise((resolve) => {
            controller.signal.addEventListener("abort", resolve, { once: true });
          });
        }
        try {
          await lease.assertOwned();
        } catch {
          send({ type: "ownership-aborted" });
        }
        await callbackUnwound;
        return;
      }
      await callbackReleased;
      await lease.assertOwned();
    }, { signal: controller.signal });
  }
  send({ type: "done" });
} catch (error) {
  send({
    type: "rejected",
    message: error instanceof Error ? error.message : "unknown",
  });
} finally {
  clearInterval(ticks);
  process.disconnect();
}
