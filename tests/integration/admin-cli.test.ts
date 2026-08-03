import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SetupServerDependencies } from "../../src/admin/setup-server.js";
import {
  registerPanSyncConfigureCli,
  remoteSetupUrls,
  type PanSyncConfigureCliApi,
} from "../../src/admin/cli.js";

type Action = () => Promise<void> | void;

class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  actionHandler?: Action;

  command(spec: string): FakeCommand {
    const name = spec.split(" ")[0] ?? spec;
    const child = new FakeCommand();
    this.children.set(name, child);
    return child;
  }

  description(): this {
    return this;
  }

  action(handler: Action): this {
    this.actionHandler = handler;
    return this;
  }
}

describe("OpenClaw configuration CLI", () => {
  it("builds sorted unique remote URLs from non-internal IPv4 interfaces", () => {
    const localUrl = "http://127.0.0.1:43891/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    expect(remoteSetupUrls(localUrl, {
      Ethernet: [
        { address: "192.168.10.8", family: "IPv4", internal: false },
        { address: "192.168.10.8", family: "IPv4", internal: false },
      ],
      Loopback: [
        { address: "127.0.0.1", family: "IPv4", internal: true },
      ],
      VPN: [
        { address: "10.8.0.2", family: 4, internal: false },
        { address: "fd00::2", family: "IPv6", internal: false },
      ],
    })).toEqual([
      "http://10.8.0.2:43891/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "http://192.168.10.8:43891/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]);
  });

  it("returns no remote URL when the host has no non-internal IPv4 interface", () => {
    expect(remoteSetupUrls("http://127.0.0.1:43891/#key", {
      Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    })).toEqual([]);
  });

  it("registers and launches pan-sync configure without an OpenClaw runtime state facade", async () => {
    const dataDir = path.join("C:\\prepared-state", "pan-sync-helper");
    const program = new FakeCommand();
    let registrar: ((context: { program: FakeCommand }) => void | Promise<void>) | undefined;
    let registrationOptions: unknown;
    const api = {
      rootDir: "C:\\plugin",
      registerCli(callback: typeof registrar, options: unknown) {
        registrar = callback;
        registrationOptions = options;
      },
    } as unknown as PanSyncConfigureCliApi;
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async (dependencies: SetupServerDependencies) => ({
      url: "http://127.0.0.1:43891/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      port: 43891,
      close,
      closed: new Promise<void>(() => undefined),
      isAuthorized: () => true,
      accessKeyBuffer: Buffer.alloc(32, 1),
    }));
    const lines: string[] = [];
    const signalHandlers = new Map<string, () => void>();
    const processEvents = {
      once(signal: string, handler: () => void) {
        signalHandlers.set(signal, handler);
        return process;
      },
      off(signal: string) {
        signalHandlers.delete(signal);
        return process;
      },
    };
    const serverDependencies = {
      store: {} as SetupServerDependencies["store"],
      provider: {} as SetupServerDependencies["provider"],
      orchestrator: {} as SetupServerDependencies["orchestrator"],
      dataDir,
      assetsDir: path.join("C:\\plugin", "ui"),
      clock: Date.now,
      randomBytes: Buffer.alloc,
    };

    registerPanSyncConfigureCli(api, serverDependencies, {
      startServer,
      writeLine: (line) => lines.push(line),
      processEvents,
      networkInterfaces: () => ({
        Ethernet: [{
          address: "192.168.10.8",
          family: "IPv4",
          internal: false,
        }],
      }),
    });
    expect(registrationOptions).toEqual({
      descriptors: [{
        name: "pan-sync",
        description: "Configure Sheen PanSync",
        hasSubcommands: true,
      }],
    });
    await registrar?.({ program });
    const configure = program.children.get("pan-sync")?.children.get("configure");
    expect(configure).toBeDefined();
    await configure?.actionHandler?.();

    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      dataDir,
    }));
    expect(lines).toEqual([
      "Sheen PanSync configuration page is ready for 10 minutes.",
      "Local URL: http://127.0.0.1:43891/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "Remote URL: http://192.168.10.8:43891/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "Cloud/NAT note: if this address is private, replace only the host with the server public IP; keep port 43891 and the same fragment.",
      "Temporarily allow TCP port 43891 in the host firewall and cloud security group when required.",
      "After configuration, remove only the temporary access rules created for this session.",
    ]);
    expect(lines.join("\n")).not.toContain(dataDir);
    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    signalHandlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("uses its selected port in Cloud/NAT guidance when remote IPv4 is unavailable", async () => {
    const program = new FakeCommand();
    const lines: string[] = [];
    const close = vi.fn(async () => undefined);
    const api = {
      registerCli(registrar: (context: { program: FakeCommand }) => void) {
        registrar({ program });
      },
    } as unknown as PanSyncConfigureCliApi;

    registerPanSyncConfigureCli(api, {
      store: {} as SetupServerDependencies["store"],
      provider: {} as SetupServerDependencies["provider"],
      orchestrator: {} as SetupServerDependencies["orchestrator"],
      dataDir: "C:\\prepared-state\\pan-sync-helper",
      assetsDir: "C:\\plugin\\ui",
      clock: Date.now,
      randomBytes: Buffer.alloc,
    }, {
      startServer: async () => ({
        url: "http://127.0.0.1:47077/#key",
        port: 47077,
        close,
        closed: new Promise<void>(() => undefined),
        isAuthorized: () => true,
        accessKeyBuffer: Buffer.alloc(32, 1),
      }),
      writeLine: (line) => lines.push(line),
      processEvents: { once: vi.fn(), off: vi.fn() },
      networkInterfaces: () => ({
        Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      }),
    });

    await program.children.get("pan-sync")?.children.get("configure")?.actionHandler?.();

    expect(lines).toContain("Remote URL: no non-loopback IPv4 address detected.");
    expect(lines).toContain(
      "Cloud/NAT note: if this address is private, replace only the host with the server public IP; keep port 47077 and the same fragment.",
    );
    expect(close).not.toHaveBeenCalled();
  });
});
