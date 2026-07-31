import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

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
  let server: Server;

  server = createServer((request, response) => {
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
    throw new Error("fake Aliyun server did not bind a TCP port");
  }

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
