import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginConfigSchema,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  registerPanSyncConfigureCli,
  type ConfigureCliOptions,
} from "./admin/cli.js";
import { createPanSyncStatusRoute } from "./admin/status-route.js";
import { resolvePluginConfig } from "./config.js";
import { createFilesystemCredentialLeaseRunner } from "./credentials/filesystem-lease.js";
import { CredentialStore } from "./credentials/store.js";
import { TokenManager } from "./credentials/token-manager.js";
import { ProviderRegistry } from "./provider-registry.js";
import { AliyunHttpClient } from "./providers/aliyun/http.js";
import { AliyunProvider } from "./providers/aliyun/provider.js";
import { registerPanSyncUploadTool } from "./tool.js";
import { UploadOrchestrator } from "./upload/orchestrator.js";

const PLUGIN_ID = "pan-sync-helper";
const PLUGIN_NAME = "Pan Sync Helper";
const STATUS_PATH = "/plugins/pan-sync-helper/status";
const ASSETS_DIR = fileURLToPath(new URL("../ui", import.meta.url));

const configSchema: OpenClawPluginConfigSchema = {
  safeParse(value) {
    try {
      return { success: true, data: resolvePluginConfig(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [{
            path: [],
            message: error instanceof Error
              ? error.message
              : "invalid plugin configuration",
          }],
        },
      };
    }
  },
  parse: resolvePluginConfig,
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      defaultDirectory: {
        type: "string",
        default: "/openClawShare",
      },
      tokenGuideUrl: {
        type: "string",
        format: "uri",
      },
    },
  },
};

export type PanSyncPluginEntryOptions = {
  configureCliOptions?: ConfigureCliOptions;
};

export function createPanSyncPluginEntry(
  options: PanSyncPluginEntryOptions = {},
): OpenClawPluginDefinition {
  return definePluginEntry({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: "Upload OpenClaw workspace files to a configured cloud drive",
    configSchema,
    register(api) {
      const config = resolvePluginConfig(api.pluginConfig);
      const dataDir = path.join(
        api.runtime.state.resolveStateDir(),
        PLUGIN_ID,
      );
      const lease = createFilesystemCredentialLeaseRunner(
        path.join(dataDir, "locks"),
      );
      const store = new CredentialStore(dataDir, lease);
      const httpClient = new AliyunHttpClient();
      const tokenManager = new TokenManager(store, httpClient);
      const provider = new AliyunProvider({
        httpClient,
        tokenManager,
      });
      const providerRegistry = new ProviderRegistry([provider], "aliyun");
      const orchestrator = new UploadOrchestrator({
        providerRegistry,
        tokenManager,
        config,
      });

      registerPanSyncUploadTool(api, orchestrator);
      registerPanSyncConfigureCli(api, {
        store,
        provider,
        orchestrator,
        dataDir,
        assetsDir: ASSETS_DIR,
        clock: Date.now,
        randomBytes,
        defaultDirectory: config.defaultDirectory,
        ...(config.tokenGuideUrl === undefined
          ? {}
          : { tokenGuideUrl: config.tokenGuideUrl }),
      }, options.configureCliOptions);
      api.registerHttpRoute({
        path: STATUS_PATH,
        auth: "gateway",
        match: "exact",
        handler: createPanSyncStatusRoute({
          store,
          tokenManager,
          config,
        }),
      });
      api.session.controls.registerControlUiDescriptor({
        surface: "tab",
        id: PLUGIN_ID,
        label: PLUGIN_NAME,
        requiredScopes: ["operator.write"],
        path: STATUS_PATH,
      });
      api.registerService({
        id: PLUGIN_ID,
        start: () => store.initialize(),
        stop: () => tokenManager.clearSnapshots(),
      });
    },
  });
}

const pluginEntry: OpenClawPluginDefinition = createPanSyncPluginEntry();

export default pluginEntry;
