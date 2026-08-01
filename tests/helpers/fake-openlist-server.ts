import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

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
  let server: Server;

  server = createServer((request, response) => {
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
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake OpenList server did not bind a TCP port");
  }

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
