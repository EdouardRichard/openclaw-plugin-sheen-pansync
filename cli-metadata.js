import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const cliMetadataEntry = definePluginEntry({
  id: "pan-sync-helper",
  name: "Pan Sync Helper",
  description: "Upload OpenClaw workspace files to a configured cloud drive",
  register(api) {
    api.registerCli(async ({ program }) => {
      const { registerPanSyncCli } = await import("./dist/cli-entry.js");
      registerPanSyncCli(program, {
        pluginConfig: api.pluginConfig,
        pluginRoot: api.rootDir,
      });
    }, {
      descriptors: [{
        name: "pan-sync",
        description: "Configure Pan Sync Helper",
        hasSubcommands: true,
      }],
    });
  },
});

export default cliMetadataEntry;
