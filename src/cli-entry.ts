import { randomBytes } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  registerPanSyncConfigureCommand,
  type CliCommand,
} from "./admin/cli.js";
import { createPanSyncRuntime } from "./runtime-composition.js";

export type RegisterPanSyncCliOptions = {
  pluginConfig: unknown;
  pluginRoot: string;
};

export function registerPanSyncCli(
  program: CliCommand,
  options: RegisterPanSyncCliOptions,
): void {
  const runtime = createPanSyncRuntime({
    stateDir: resolveStateDir(),
    pluginConfig: options.pluginConfig,
  });
  registerPanSyncConfigureCommand(program, {
    store: runtime.store,
    provider: runtime.provider,
    orchestrator: runtime.orchestrator,
    dataDir: runtime.dataDir,
    assetsDir: path.join(options.pluginRoot, "ui"),
    clock: Date.now,
    randomBytes,
    defaultDirectory: runtime.config.defaultDirectory,
    ...(runtime.config.tokenGuideUrl === undefined
      ? {}
      : { tokenGuideUrl: runtime.config.tokenGuideUrl }),
  });
}
