const [storeModule, leaseModule, serviceModule, managerModule] = await Promise.all([
  import(process.env.PAN_SYNC_STORE_MODULE_URL),
  import(process.env.PAN_SYNC_LEASE_MODULE_URL),
  import(process.env.PAN_SYNC_TOKEN_SERVICE_MODULE_URL),
  import(process.env.PAN_SYNC_TOKEN_MANAGER_MODULE_URL),
]);

const send = (message) => {
  if (process.connected) process.send({ ...message, pid: process.pid });
};

const finish = (message) => new Promise((resolve) => {
  if (!process.connected) {
    resolve();
    return;
  }
  process.send({ ...message, pid: process.pid }, resolve);
});

const waitForGo = new Promise((resolve) => {
  process.on("message", (message) => {
    if (message?.type === "go") resolve();
  });
});

const runner = managerModule.makeReentrantCredentialLeaseRunner(
  leaseModule.createSqliteWorkerCredentialLeaseRunner(
    process.env.PAN_SYNC_LEASE_DATABASE,
  ),
);
const store = new storeModule.CredentialStore(
  process.env.PAN_SYNC_DATA_DIR,
  runner,
);
const tokenService = new serviceModule.OpenListTokenService();
const tokenManager = new managerModule.TokenManager({
  store,
  tokenService,
  runWithRefreshLease: runner,
});

send({ type: "started" });
await waitForGo;
send({ type: "refreshing" });

try {
  const value = await tokenManager.forceRefresh("access-stale");
  await finish({ type: "result", value });
} catch (error) {
  await finish({
    type: "error",
    code: error && typeof error === "object" && "code" in error
      ? error.code
      : "UNKNOWN",
  });
}
process.exit(0);
