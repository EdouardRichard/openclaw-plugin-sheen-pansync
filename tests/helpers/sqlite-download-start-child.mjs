const send = (message) => {
  if (process.connected) process.send(message);
};
const controller = new AbortController();

process.on("message", (message) => {
  if (message?.type === "cancel") controller.abort();
});

send({ type: "started" });
try {
  const {
    createSqliteWorkerDownloadStartStore,
  } = await import(process.env.PAN_SYNC_DOWNLOAD_START_STORE_MODULE_URL);
  const {
    AliyunDownloadStartLimiter,
  } = await import(process.env.PAN_SYNC_DOWNLOAD_START_LIMITER_MODULE_URL);
  const store = createSqliteWorkerDownloadStartStore(
    process.env.PAN_SYNC_DOWNLOAD_START_DATABASE,
    {
      limit: Number(process.env.PAN_SYNC_DOWNLOAD_START_LIMIT),
      windowMs: Number(process.env.PAN_SYNC_DOWNLOAD_START_WINDOW_MS),
      guardMs: Number(process.env.PAN_SYNC_DOWNLOAD_START_GUARD_MS),
    },
  );
  const limiter = new AliyunDownloadStartLimiter({ store });
  send({ type: "acquiring" });
  await limiter.acquire(controller.signal);
  send({ type: "granted", grantedAt: Date.now() });
} catch {
  send({ type: controller.signal.aborted ? "cancelled" : "failed" });
} finally {
  process.disconnect();
}
