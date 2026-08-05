import path from "node:path";
import { resolvePluginConfig, type PluginConfig } from "./config.js";
import { createSqliteWorkerCredentialLeaseRunner } from "./credentials/sqlite-worker-lease.js";
import {
  type CredentialLeaseRunner,
  CredentialStore,
} from "./credentials/store.js";
import {
  makeReentrantCredentialLeaseRunner,
  TokenManager,
} from "./credentials/token-manager.js";
import { ProviderRegistry } from "./provider-registry.js";
import {
  AliyunDownloadStartLimiter,
  type DownloadStartReservationStore,
} from "./providers/aliyun/download-start-limiter.js";
import { OpenListTokenService } from "./providers/aliyun/openlist-token-service.js";
import { AliyunProvider } from "./providers/aliyun/provider.js";
import { createSqliteWorkerDownloadStartStore } from "./providers/aliyun/sqlite-download-start-store.js";
import { ReadOrchestrator } from "./read/orchestrator.js";
import { UploadOrchestrator } from "./upload/orchestrator.js";

const PLUGIN_DATA_DIRECTORY = "pan-sync-helper";

export type PanSyncRuntime = {
  config: PluginConfig;
  dataDir: string;
  store: CredentialStore;
  tokenService: OpenListTokenService;
  tokenManager: TokenManager;
  provider: AliyunProvider;
  providerRegistry: ProviderRegistry;
  orchestrator: UploadOrchestrator;
  readOrchestrator: ReadOrchestrator;
};

export type CreatePanSyncRuntimeOptions = {
  stateDir: string;
  pluginConfig: unknown;
  credentialLeaseFactory?: (databasePath: string) => CredentialLeaseRunner;
  downloadStartStoreFactory?: (
    databasePath: string,
  ) => DownloadStartReservationStore;
};

export function createPanSyncRuntime(
  options: CreatePanSyncRuntimeOptions,
): PanSyncRuntime {
  const config = resolvePluginConfig(options.pluginConfig);
  const dataDir = path.join(options.stateDir, PLUGIN_DATA_DIRECTORY);
  const leaseDatabasePath = path.join(dataDir, "locks", "lease.sqlite");
  const downloadLimitDatabasePath = path.join(
    dataDir,
    "locks",
    "download-rate-limit.sqlite",
  );
  const lease = makeReentrantCredentialLeaseRunner((
    options.credentialLeaseFactory
    ?? createSqliteWorkerCredentialLeaseRunner
  )(leaseDatabasePath));
  const store = new CredentialStore(dataDir, lease);
  const tokenService = new OpenListTokenService();
  const tokenManager = new TokenManager({
    store,
    tokenService,
    runWithRefreshLease: lease,
  });
  const downloadStartStore = (
    options.downloadStartStoreFactory
    ?? createSqliteWorkerDownloadStartStore
  )(downloadLimitDatabasePath);
  const downloadStartLimiter = new AliyunDownloadStartLimiter({
    store: downloadStartStore,
  });
  const provider = new AliyunProvider({
    tokenService,
    tokenManager,
    downloadStartLimiter,
  });
  const providerRegistry = new ProviderRegistry([provider], "aliyun");
  const orchestrator = new UploadOrchestrator({
    providerRegistry,
    tokenManager,
    config,
  });
  const readOrchestrator = new ReadOrchestrator({
    providerRegistry,
    tokenManager,
  });

  return {
    config,
    dataDir,
    store,
    tokenService,
    tokenManager,
    provider,
    providerRegistry,
    orchestrator,
    readOrchestrator,
  };
}
