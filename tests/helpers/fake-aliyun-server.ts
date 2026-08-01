import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { bindFetchSafeLoopbackServer } from "../../src/net/fetch-safe-loopback.js";

export type FakeAliyunRequest = {
  method: string;
  path: string;
  body: unknown;
};

export type FakeAliyunResponse = {
  status: number;
  body?: unknown;
  hang?: boolean;
};

export type FakeAliyunServer = {
  baseUrl: string;
  requests: FakeAliyunRequest[];
  close(): Promise<void>;
};

export async function startFakeAliyunServer(
  responses: FakeAliyunResponse | FakeAliyunResponse[],
): Promise<FakeAliyunServer> {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const requests: FakeAliyunRequest[] = [];
  const sockets = new Set<Socket>();
  const requestListener: RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const serialized = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: serialized === "" ? undefined : JSON.parse(serialized),
      });

      const next = queue.shift() ?? queue.at(-1);
      if (next === undefined || next.hang === true) {
        return;
      }

      response.writeHead(next.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(next.body ?? {}));
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
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
