import { networkInterfaces } from "node:os";
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
  networkInterfaces?: () => NetworkInterfaceSnapshot;
};

export type NetworkAddressSnapshot = {
  address: string;
  family: string | number;
  internal: boolean;
};

export type NetworkInterfaceSnapshot = Record<
  string,
  readonly NetworkAddressSnapshot[] | undefined
>;

export function remoteSetupUrls(
  localUrl: string,
  interfaces: NetworkInterfaceSnapshot,
): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && (entry.family === "IPv4" || entry.family === 4)) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((address) => {
      const remote = new URL(localUrl);
      remote.hostname = address;
      return remote.toString();
    });
}

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
      description: "Configure Sheen PanSync",
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
  const readNetworkInterfaces = options.networkInterfaces ?? networkInterfaces;

  const panSync = program
    .command("pan-sync")
    .description("Configure and inspect Sheen PanSync");
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

      writeLine("Sheen PanSync configuration page is ready for 10 minutes.");
      writeLine(`Local URL: ${server.url}`);
      let remoteUrls: string[] = [];
      try {
        remoteUrls = remoteSetupUrls(server.url, readNetworkInterfaces());
      } catch {
        // Interface discovery is best effort; the local setup URL remains usable.
      }
      if (remoteUrls.length === 0) {
        writeLine("Remote URL: no non-loopback IPv4 address detected.");
      } else {
        for (const remoteUrl of remoteUrls) {
          writeLine(`Remote URL: ${remoteUrl}`);
        }
      }
      writeLine(
        `Cloud/NAT note: if this address is private, replace only the host with the server public IP; keep port ${server.port} and the same fragment.`,
      );
      writeLine(
        `Temporarily allow TCP port ${server.port} in the host firewall and cloud security group when required.`,
      );
      writeLine("After configuration, remove only the temporary access rules created for this session.");
    });
}
