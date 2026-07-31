import path from "node:path";
import { resolvePluginConfig, type PluginConfig } from "./config.js";
import { createSqliteWorkerCredentialLeaseRunner } from "./credentials/sqlite-worker-lease.js";
import {
  type CredentialLeaseRunner,
  CredentialStore,
} from "./credentials/store.js";
import { TokenManager } from "./credentials/token-manager.js";
import { ProviderRegistry } from "./provider-registry.js";
import { AliyunHttpClient } from "./providers/aliyun/http.js";
import { AliyunProvider } from "./providers/aliyun/provider.js";
import { UploadOrchestrator } from "./upload/orchestrator.js";

const PLUGIN_DATA_DIRECTORY = "pan-sync-helper";

export type PanSyncRuntime = {
  config: PluginConfig;
  dataDir: string;
  store: CredentialStore;
  httpClient: AliyunHttpClient;
  tokenManager: TokenManager;
  provider: AliyunProvider;
  providerRegistry: ProviderRegistry;
  orchestrator: UploadOrchestrator;
};

export type CreatePanSyncRuntimeOptions = {
  stateDir: string;
  pluginConfig: unknown;
  credentialLeaseFactory?: (databasePath: string) => CredentialLeaseRunner;
};

export function createPanSyncRuntime(
  options: CreatePanSyncRuntimeOptions,
): PanSyncRuntime {
  const config = resolvePluginConfig(options.pluginConfig);
  const dataDir = path.join(options.stateDir, PLUGIN_DATA_DIRECTORY);
  const leaseDatabasePath = path.join(dataDir, "locks", "lease.sqlite");
  const lease = (
    options.credentialLeaseFactory
    ?? createSqliteWorkerCredentialLeaseRunner
  )(leaseDatabasePath);
  const store = new CredentialStore(dataDir, lease);
  const httpClient = new AliyunHttpClient();
  const tokenManager = new TokenManager(store, httpClient);
  const provider = new AliyunProvider({ httpClient, tokenManager });
  const providerRegistry = new ProviderRegistry([provider], "aliyun");
  const orchestrator = new UploadOrchestrator({
    providerRegistry,
    tokenManager,
    config,
  });

  return {
    config,
    dataDir,
    store,
    httpClient,
    tokenManager,
    provider,
    providerRegistry,
    orchestrator,
  };
}
