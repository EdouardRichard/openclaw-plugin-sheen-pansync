import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindFetchSafeServer,
  bindFetchSafeLoopbackServer,
  isFetchSafePort,
} from "../../src/net/fetch-safe-loopback.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("bindFetchSafeLoopbackServer", () => {
  it("binds the generic Fetch-safe server to the requested IPv4 host", async () => {
    const binding = await bindFetchSafeServer({
      host: "0.0.0.0",
      createServer() {
        const server = createServer();
        servers.push(server);
        return server;
      },
    });

    expect(binding.address.address).toBe("0.0.0.0");
    expect(binding.address.family).toBe("IPv4");
  });

  it("keeps the loopback wrapper on IPv4 loopback", async () => {
    const binding = await bindFetchSafeLoopbackServer({
      createServer() {
        const server = createServer();
        servers.push(server);
        return server;
      },
    });

    expect(binding.address.address).toBe("127.0.0.1");
  });

  it("rejects ports that the Fetch standard blocks", () => {
    expect(isFetchSafePort(6000)).toBe(false);
    expect(isFetchSafePort(49_152)).toBe(true);
  });

  it("rebinds when the first ephemeral port is rejected by the Fetch safety policy", async () => {
    const isPortSafe = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    let serverCount = 0;

    const binding = await bindFetchSafeLoopbackServer({
      createServer() {
        serverCount += 1;
        const server = createServer();
        servers.push(server);
        return server;
      },
      isPortSafe,
    });

    expect(isPortSafe).toHaveBeenCalledTimes(2);
    expect(serverCount).toBe(2);
    expect(binding.server.listening).toBe(true);
  });

  it("closes the candidate before rethrowing a Fetch safety policy error", async () => {
    const policyError = new Error("FETCH_SAFETY_POLICY_CANARY");
    let candidate!: Server;
    let closeCompleted = false;

    await expect(bindFetchSafeLoopbackServer({
      createServer() {
        candidate = createServer();
        candidate.once("close", () => {
          closeCompleted = true;
        });
        servers.push(candidate);
        return candidate;
      },
      isPortSafe() {
        throw policyError;
      },
    })).rejects.toBe(policyError);

    expect(closeCompleted).toBe(true);
    expect(candidate.listening).toBe(false);
    expect(candidate.address()).toBeNull();
  });

  it("keeps the policy error primary when candidate cleanup also fails", async () => {
    const policyError = new Error("FETCH_SAFETY_POLICY_PRIMARY_CANARY");
    const closeError = new Error("FETCH_SAFETY_POLICY_CLOSE_CANARY");
    let candidate!: Server;
    let originalClose!: Server["close"];
    let closeCompleted = false;

    try {
      await expect(bindFetchSafeLoopbackServer({
        createServer() {
          candidate = createServer();
          servers.push(candidate);
          originalClose = candidate.close.bind(candidate);
          candidate.close = ((callback?: (error?: Error) => void) =>
            originalClose(() => {
              closeCompleted = true;
              callback?.(closeError);
            })) as Server["close"];
          return candidate;
        },
        isPortSafe() {
          throw policyError;
        },
      })).rejects.toBe(policyError);

      expect(closeCompleted).toBe(true);
      expect(candidate.listening).toBe(false);
      expect(candidate.address()).toBeNull();
    } finally {
      if (candidate !== undefined && originalClose !== undefined) {
        candidate.close = originalClose;
      }
    }
  });
});
