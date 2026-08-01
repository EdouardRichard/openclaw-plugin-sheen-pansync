import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { bindFetchSafeLoopbackServer } from "../../src/net/fetch-safe-loopback.js";

export type FakeOpenListRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type FakeOpenListResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  hang?: boolean;
};

export type FakeOpenListServer = {
  baseUrl: string;
  requests: FakeOpenListRequest[];
  close(): Promise<void>;
};

export async function startFakeOpenListServer(
  responses: FakeOpenListResponse | FakeOpenListResponse[],
): Promise<FakeOpenListServer> {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const requests: FakeOpenListRequest[] = [];
  const sockets = new Set<Socket>();
  const requestListener: RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? ""}`,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      const next = queue.shift();
      if (next === undefined || next.hang === true) {
        return;
      }

      response.writeHead(next.status, {
        "content-type": "application/json",
        ...next.headers,
      });
      response.end(
        typeof next.body === "string"
          ? next.body
          : JSON.stringify(next.body ?? {}),
      );
    });
  };
  const { server, address } = await bindFetchSafeLoopbackServer({
    createServer() {
      const candidate = createServer(requestListener);
      candidate.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      return candidate;
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
