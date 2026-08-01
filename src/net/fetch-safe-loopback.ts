import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export function isFetchSafePort(port: number): boolean {
  return port >= 1 && port <= 65_535 && !FETCH_FORBIDDEN_PORTS.has(port);
}

export type FetchSafeLoopbackBinding = {
  server: Server;
  address: AddressInfo;
};

export type FetchSafeLoopbackOptions = {
  createServer(): Server;
  port?: number;
  isPortSafe?: (port: number) => boolean;
  addressUnavailableMessage?: string;
  fixedPortRejectedMessage?: string;
  selectionExhaustedMessage?: string;
};

function closeListeningServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function waitUntilListening(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function bindFetchSafeLoopbackServer(
  options: FetchSafeLoopbackOptions,
): Promise<FetchSafeLoopbackBinding> {
  const port = options.port ?? 0;
  const portIsSafe = options.isPortSafe ?? isFetchSafePort;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const server = options.createServer();
    await waitUntilListening(server, port);
    const address = server.address();
    if (address === null || typeof address === "string") {
      await closeListeningServer(server);
      throw new Error(
        options.addressUnavailableMessage ?? "loopback server address unavailable",
      );
    }
    if (portIsSafe(address.port)) {
      return { server, address };
    }
    await closeListeningServer(server);
    if (port !== 0) {
      throw new Error(
        options.fixedPortRejectedMessage ?? "loopback server port rejected by Fetch",
      );
    }
  }
  throw new Error(
    options.selectionExhaustedMessage
      ?? "loopback server could not select a Fetch-safe port",
  );
}
