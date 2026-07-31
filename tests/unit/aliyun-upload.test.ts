import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, open, rm, truncate } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedWorkspaceFile } from "../../src/workspace/path-guard.js";
import { PanSyncError } from "../../src/errors.js";
import { AliyunHttpClient } from "../../src/providers/aliyun/http.js";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";

const MIB = 1024 * 1024;
const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const cleanups: Array<() => Promise<void>> = [];

type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
};

type UploadServer = {
  baseUrl: string;
  requests: RecordedRequest[];
  putSizes: Map<number, number>;
  events: string[];
  maxConcurrentPuts: () => number;
  close(): Promise<void>;
};

type UploadServerOptions = {
  createResponses?: Array<{ status: number; body: unknown }>;
  completeName?: string;
  failPutPart?: number;
  delayPuts?: boolean;
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function requestBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startUploadServer(
  options: UploadServerOptions = {},
): Promise<UploadServer> {
  const requests: RecordedRequest[] = [];
  const putSizes = new Map<number, number>();
  const events: string[] = [];
  const sockets = new Set<Socket>();
  const createResponses = [...(options.createResponses ?? [])];
  let activePuts = 0;
  let maximumPuts = 0;
  let baseUrl = "";

  const server: Server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", baseUrl);
    const bodyBuffer = await requestBuffer(request);
    const partMatch = /^\/signed\/(?:refreshed-)?(\d+)$/.exec(requestUrl.pathname);
    if (request.method === "PUT" && partMatch !== null) {
      const partNumber = Number(partMatch[1]);
      activePuts += 1;
      maximumPuts = Math.max(maximumPuts, activePuts);
      events.push(`put-${partNumber}-start`);
      putSizes.set(partNumber, bodyBuffer.length);
      if (options.delayPuts === true) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      activePuts -= 1;
      events.push(`put-${partNumber}-end`);
      if (options.failPutPart === partNumber) {
        response.writeHead(500);
        response.end("signed-url-secret-CANARY");
        return;
      }
      response.writeHead(200);
      response.end();
      return;
    }

    const body = bodyBuffer.length === 0
      ? undefined
      : JSON.parse(bodyBuffer.toString("utf8")) as unknown;
    requests.push({
      method: request.method ?? "",
      path: requestUrl.pathname,
      body,
    });

    if (requestUrl.pathname.endsWith("/openFile/create")) {
      const queued = createResponses.shift();
      if (queued !== undefined) {
        response.writeHead(queued.status, { "content-type": "application/json" });
        response.end(JSON.stringify(queued.body));
        return;
      }
      const requestedParts =
        typeof body === "object"
        && body !== null
        && "part_info_list" in body
        && Array.isArray(body.part_info_list)
          ? body.part_info_list as Array<{ part_number: number }>
          : [];
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        drive_id: "drive-default",
        file_id: "remote-file",
        upload_id: "upload-1",
        file_name: options.completeName ?? "report (1).bin",
        part_info_list: requestedParts.map(({ part_number }) => ({
          part_number,
          upload_url: `${baseUrl}/signed/${part_number}?secret=upload-url-CANARY`,
        })),
      }));
      return;
    }

    if (requestUrl.pathname.endsWith("/openFile/getUploadUrl")) {
      const requestedParts =
        typeof body === "object"
        && body !== null
        && "part_info_list" in body
        && Array.isArray(body.part_info_list)
          ? body.part_info_list as Array<{ part_number: number }>
          : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        part_info_list: requestedParts.map(({ part_number }) => ({
          part_number,
          upload_url:
            `${baseUrl}/signed/refreshed-${part_number}?secret=refreshed-CANARY`,
        })),
      }));
      return;
    }

    if (requestUrl.pathname.endsWith("/openFile/complete")) {
      events.push("complete");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        file_id: "remote-file",
        name: options.completeName ?? "report (1).bin",
      }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
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
    throw new Error("upload server did not bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  const fixture: UploadServer = {
    baseUrl,
    requests,
    putSizes,
    events,
    maxConcurrentPuts: () => maximumPuts,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
  cleanups.push(fixture.close);
  return fixture;
}

async function sparseFile(
  size: number,
  basename = "report.bin",
): Promise<ResolvedWorkspaceFile> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aliyun-upload-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, basename);
  const handle = await open(filename, "w+");
  await truncate(filename, size);
  cleanups.push(() => handle.close().catch(() => undefined));
  return {
    inputName: basename,
    basename,
    size,
    handle,
  };
}

function provider(
  server: UploadServer,
  options: {
    forceRefresh?: (token?: string) => Promise<string>;
    clock?: () => number;
  } = {},
): AliyunProvider {
  return new AliyunProvider({
    httpClient: new AliyunHttpClient({ baseUrl: server.baseUrl }),
    baseUrl: server.baseUrl,
    tokenManager: {
      forceRefresh: options.forceRefresh ?? (async () => "access-new"),
    },
    clock: options.clock ?? (() => NOW),
  });
}

async function rejectedPanSyncError(
  run: () => Promise<unknown>,
): Promise<PanSyncError> {
  let rejected: unknown;
  try {
    await run();
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(PanSyncError);
  return rejected as PanSyncError;
}

describe("Aliyun multipart upload", () => {
  it("streams a 45 MiB descriptor in 20 MiB parts before completing with the server-resolved name", async () => {
    const server = await startUploadServer({ delayPuts: true });
    const file = await sparseFile(45 * MIB);

    const result = await provider(server).uploadFile({
      accessToken: "access-old",
      remoteDirectory: {
        id: "folder-1",
        path: "/openClawShare",
        driveId: "drive-default",
      },
      file,
    });

    const create = server.requests.find(({ path: requestPath }) =>
      requestPath.endsWith("/openFile/create")
    );
    expect(create?.body).toEqual({
      drive_id: "drive-default",
      parent_file_id: "folder-1",
      name: "report.bin",
      type: "file",
      check_name_mode: "auto_rename",
      size: 45 * MIB,
      part_info_list: [
        { part_number: 1 },
        { part_number: 2 },
        { part_number: 3 },
      ],
    });
    expect([...server.putSizes.entries()].sort(([left], [right]) => left - right))
      .toEqual([
        [1, 20 * MIB],
        [2, 20 * MIB],
        [3, 5 * MIB],
      ]);
    expect(server.events.at(-1)).toBe("complete");
    expect(server.events.filter((event) => event.endsWith("-end"))).toHaveLength(3);
    expect(result).toEqual({
      remoteName: "report (1).bin",
      size: 45 * MIB,
    });
  });

  it("limits concurrent part PUTs to three", async () => {
    const server = await startUploadServer({ delayPuts: true });
    const file = await sparseFile(65 * MIB);

    await provider(server).uploadFile({
      accessToken: "access-old",
      remoteDirectory: {
        id: "folder-1",
        path: "/openClawShare",
        driveId: "drive-default",
      },
      file,
    });

    expect(server.putSizes.size).toBe(4);
    expect(server.maxConcurrentPuts()).toBe(3);
  });

  it("raises part size so a very large file never exceeds 10,000 parts", async () => {
    const server = await startUploadServer({
      createResponses: [{
        status: 409,
        body: { code: "SpaceNotEnough" },
      }],
    });
    const file = await sparseFile(1);
    const oversizedPartBoundary = 20 * MIB * 10_000 + 1;
    const representedFile = {
      ...file,
      size: oversizedPartBoundary,
    };

    const error = await rejectedPanSyncError(() =>
      provider(server).uploadFile({
        accessToken: "access-old",
        remoteDirectory: {
          id: "folder-1",
          path: "/openClawShare",
          driveId: "drive-default",
        },
        file: representedFile,
      })
    );

    const create = server.requests.find(({ path: requestPath }) =>
      requestPath.endsWith("/openFile/create")
    );
    const body = create?.body as { part_info_list?: unknown[] } | undefined;
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(body?.part_info_list).toHaveLength(10_000);
    expect(body?.part_info_list?.at(0)).toEqual({ part_number: 1 });
    expect(body?.part_info_list?.at(-1)).toEqual({ part_number: 10_000 });
  });

  it("creates and completes a zero-byte upload without PUT requests", async () => {
    const server = await startUploadServer({ completeName: "empty.txt" });
    const file = await sparseFile(0, "empty.txt");

    await expect(
      provider(server).uploadFile({
        accessToken: "access-old",
        remoteDirectory: {
          id: "folder-1",
          path: "/openClawShare",
          driveId: "drive-default",
        },
        file,
      }),
    ).resolves.toEqual({
      remoteName: "empty.txt",
      size: 0,
    });

    const create = server.requests.find(({ path: requestPath }) =>
      requestPath.endsWith("/openFile/create")
    );
    expect(create?.body).toMatchObject({ size: 0, part_info_list: [] });
    expect(server.putSizes.size).toBe(0);
    expect(server.events).toEqual(["complete"]);
  });

  it("refreshes an upload URL at 50 minutes before sending the part", async () => {
    const server = await startUploadServer();
    const file = await sparseFile(1);
    let clockCalls = 0;

    await provider(server, {
      clock: () => clockCalls++ === 0 ? NOW : NOW + 50 * 60 * 1_000,
    }).uploadFile({
      accessToken: "access-old",
      remoteDirectory: {
        id: "folder-1",
        path: "/openClawShare",
        driveId: "drive-default",
      },
      file,
    });

    expect(
      server.requests.filter(({ path: requestPath }) =>
        requestPath.endsWith("/openFile/getUploadUrl")
      ),
    ).toHaveLength(1);
    expect(server.putSizes.get(1)).toBe(1);
    expect(server.events).toContain("put-1-start");
  });

  it("refreshes the access token once when file creation returns 401", async () => {
    const server = await startUploadServer({
      createResponses: [
        { status: 401, body: { code: "AccessTokenInvalid" } },
      ],
    });
    const file = await sparseFile(1);
    const forceRefresh = vi.fn(async () => "access-new");

    await provider(server, { forceRefresh }).uploadFile({
      accessToken: "access-old",
      remoteDirectory: {
        id: "folder-1",
        path: "/openClawShare",
        driveId: "drive-default",
      },
      file,
    });

    expect(forceRefresh).toHaveBeenCalledOnce();
    expect(forceRefresh).toHaveBeenCalledWith("access-old");
    expect(
      server.requests.filter(({ path: requestPath }) =>
        requestPath.endsWith("/openFile/create")
      ),
    ).toHaveLength(2);
  });

  it("maps a second file-creation 401 to AUTHORIZATION_REVOKED", async () => {
    const server = await startUploadServer({
      createResponses: [
        { status: 401, body: { code: "AccessTokenInvalid" } },
        { status: 401, body: { code: "AccessTokenInvalidAgain" } },
      ],
    });
    const file = await sparseFile(1);
    const forceRefresh = vi.fn(async () => "access-new");

    const error = await rejectedPanSyncError(() =>
      provider(server, { forceRefresh }).uploadFile({
        accessToken: "access-old",
        remoteDirectory: {
          id: "folder-1",
          path: "/openClawShare",
          driveId: "drive-default",
        },
        file,
      })
    );

    expect(error.code).toBe("AUTHORIZATION_REVOKED");
    expect(forceRefresh).toHaveBeenCalledOnce();
    expect(forceRefresh).toHaveBeenCalledWith("access-old");
  });

  it.each([
    {
      name: "rate limiting",
      response: { status: 429, body: { detail: "rate-secret-CANARY" } },
      code: "RATE_LIMITED",
    },
    {
      name: "capacity exhaustion",
      response: {
        status: 409,
        body: { code: "SpaceNotEnough", detail: "quota-secret-CANARY" },
      },
      code: "QUOTA_EXCEEDED",
    },
  ] as const)("maps $name to $code", async ({ response, code }) => {
    const server = await startUploadServer({ createResponses: [response] });
    const file = await sparseFile(1);

    const error = await rejectedPanSyncError(() =>
      provider(server).uploadFile({
        accessToken: "access-old",
        remoteDirectory: {
          id: "folder-1",
          path: "/openClawShare",
          driveId: "drive-default",
        },
        file,
      })
    );

    expect(error.code).toBe(code);
    expect(error.message).not.toContain("secret-CANARY");
  });

  it("maps a failed PUT without exposing its signed URL", async () => {
    const server = await startUploadServer({ failPutPart: 1 });
    const file = await sparseFile(1);

    const error = await rejectedPanSyncError(() =>
      provider(server).uploadFile({
        accessToken: "access-old",
        remoteDirectory: {
          id: "folder-1",
          path: "/openClawShare",
          driveId: "drive-default",
        },
        file,
      })
    );

    expect(error.code).toBe("UPLOAD_FAILED");
    expect(error.message).toBe("UPLOAD_FAILED");
    expect(error.message).not.toContain("upload-url-CANARY");
    expect(error.message).not.toContain("/signed/");
  });
});
