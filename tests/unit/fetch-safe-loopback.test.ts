import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
});
