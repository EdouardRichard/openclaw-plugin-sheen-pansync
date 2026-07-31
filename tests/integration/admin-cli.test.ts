import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SetupServerDependencies } from "../../src/admin/setup-server.js";
import {
  registerPanSyncConfigureCli,
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
  it("registers pan-sync configure, resolves the public state dir, prints only guidance, and closes on signals", async () => {
    const stateDir = path.join("C:\\state", "openclaw");
    const program = new FakeCommand();
    let registrar: ((context: { program: FakeCommand }) => void | Promise<void>) | undefined;
    let registrationOptions: unknown;
    const api = {
      rootDir: "C:\\plugin",
      runtime: { state: { resolveStateDir: () => stateDir } },
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
      dataDir: "must-be-replaced",
      assetsDir: path.join("C:\\plugin", "ui"),
      clock: Date.now,
      randomBytes: Buffer.alloc,
    };

    registerPanSyncConfigureCli(api, serverDependencies, {
      startServer,
      writeLine: (line) => lines.push(line),
      processEvents,
    });
    expect(registrationOptions).toEqual({
      descriptors: [{
        name: "pan-sync",
        description: "Configure Pan Sync Helper",
        hasSubcommands: true,
      }],
    });
    await registrar?.({ program });
    const configure = program.children.get("pan-sync")?.children.get("configure");
    expect(configure).toBeDefined();
    await configure?.actionHandler?.();

    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      dataDir: path.join(stateDir, "pan-sync-helper"),
    }));
    expect(lines).toEqual([
      "Pan Sync Helper configuration page is ready for 10 minutes.",
      "Remote URL: http://127.0.0.1:43891/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "SSH example: ssh -L 43891:127.0.0.1:43891 user@linux.example.com",
      "Then open the Remote URL in your local browser.",
    ]);
    expect(lines.join("\n")).not.toContain("must-be-replaced");
    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    signalHandlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
