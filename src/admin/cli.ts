import {
  startSetupServer,
  type SetupServerDependencies,
  type SetupServer,
} from "./setup-server.js";

type SignalName = "SIGINT" | "SIGTERM";

type ProcessEvents = {
  once(signal: SignalName, listener: () => void): unknown;
  off(signal: SignalName, listener: () => void): unknown;
};

export type CliCommand = {
  command(spec: string): CliCommand;
  description(text: string): CliCommand;
  action(handler: () => void | Promise<void>): CliCommand;
};

export type PanSyncConfigureCliApi = {
  registerCli(
    registrar: (context: { program: CliCommand }) => void | Promise<void>,
    options: {
      descriptors: Array<{
        name: string;
        description: string;
        hasSubcommands: boolean;
      }>;
    },
  ): void;
};

export type ConfigureCliOptions = {
  startServer?: (dependencies: SetupServerDependencies) => Promise<SetupServer>;
  writeLine?: (line: string) => void;
  processEvents?: ProcessEvents;
};

export function registerPanSyncConfigureCli(
  api: PanSyncConfigureCliApi,
  dependencies: SetupServerDependencies,
  options: ConfigureCliOptions = {},
): void {
  api.registerCli(({ program }) => {
    registerPanSyncConfigureCommand(program, dependencies, options);
  }, {
    descriptors: [{
      name: "pan-sync",
      description: "Configure Pan Sync Helper",
      hasSubcommands: true,
    }],
  });
}

export function registerPanSyncConfigureCommand(
  program: CliCommand,
  dependencies: SetupServerDependencies,
  options: ConfigureCliOptions = {},
): void {
  const launchServer = options.startServer ?? startSetupServer;
  const writeLine = options.writeLine
    ?? ((line: string) => process.stdout.write(`${line}\n`));
  const processEvents = options.processEvents ?? process;

  const panSync = program
    .command("pan-sync")
    .description("Configure and inspect Pan Sync Helper");
  panSync
    .command("configure")
    .description("Open the one-time credential configuration page")
    .action(async () => {
      const server = await launchServer(dependencies);
      let stopping = false;
      const stop = (): void => {
        if (stopping) {
          return;
        }
        stopping = true;
        void server.close();
      };
      processEvents.once("SIGINT", stop);
      processEvents.once("SIGTERM", stop);
      void server.closed.finally(() => {
        processEvents.off("SIGINT", stop);
        processEvents.off("SIGTERM", stop);
      });

      writeLine("Pan Sync Helper configuration page is ready for 10 minutes.");
      writeLine(`Remote URL: ${server.url}`);
      writeLine(`SSH example: ssh -L ${server.port}:127.0.0.1:${server.port} user@linux.example.com`);
      writeLine("Then open the Remote URL in your local browser.");
    });
}
