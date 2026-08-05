import { randomBytes } from "node:crypto";
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
import type { CredentialLeaseRunner } from "./credentials/store.js";
import type { DownloadStartReservationStore } from "./providers/aliyun/download-start-limiter.js";
import { registerPanSyncReadTools } from "./read/tool.js";
import { createPanSyncRuntime } from "./runtime-composition.js";
import { registerPanSyncUploadTool } from "./tool.js";

const PLUGIN_ID = "sheen-pansync";
const PLUGIN_NAME = "Sheen PanSync";
const STATUS_PATH = "/plugins/sheen-pansync/status";
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
    },
  },
};

export type PanSyncPluginEntryOptions = {
  configureCliOptions?: ConfigureCliOptions;
  credentialLeaseFactory?: (databasePath: string) => CredentialLeaseRunner;
  downloadStartStoreFactory?: (
    databasePath: string,
  ) => DownloadStartReservationStore;
};

export function createPanSyncPluginEntry(
  options: PanSyncPluginEntryOptions = {},
): OpenClawPluginDefinition {
  return definePluginEntry({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: "Upload workspace files to and list or download files from an Aliyun Drive resource drive",
    configSchema,
    register(api) {
      const runtime = createPanSyncRuntime({
        stateDir: api.runtime.state.resolveStateDir(),
        pluginConfig: api.pluginConfig,
        ...(options.credentialLeaseFactory === undefined
          ? {}
          : { credentialLeaseFactory: options.credentialLeaseFactory }),
        ...(options.downloadStartStoreFactory === undefined
          ? {}
          : { downloadStartStoreFactory: options.downloadStartStoreFactory }),
      });

      registerPanSyncUploadTool(api, runtime.orchestrator);
      registerPanSyncReadTools(api, runtime.readOrchestrator);
      registerPanSyncConfigureCli(api, {
        store: runtime.store,
        provider: runtime.provider,
        orchestrator: runtime.orchestrator,
        dataDir: runtime.dataDir,
        assetsDir: ASSETS_DIR,
        clock: Date.now,
        randomBytes,
        defaultDirectory: runtime.config.defaultDirectory,
      }, options.configureCliOptions);
      api.registerHttpRoute({
        path: STATUS_PATH,
        auth: "gateway",
        match: "exact",
        handler: createPanSyncStatusRoute({
          store: runtime.store,
          tokenManager: runtime.tokenManager,
          config: runtime.config,
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
        start: () => runtime.store.initialize(),
        stop: () => runtime.tokenManager.clearSnapshots(),
      });
    },
  });
}

const pluginEntry: OpenClawPluginDefinition = createPanSyncPluginEntry();

export default pluginEntry;
