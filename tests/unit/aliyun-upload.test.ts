import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { mkdtemp, open, rm, truncate } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudDriveProvider, RemoteDirectory } from "../../src/contracts.js";
import type { ResolvedWorkspaceFile } from "../../src/workspace/path-guard.js";
import { PanSyncError } from "../../src/errors.js";
import { ProviderRegistry } from "../../src/provider-registry.js";
import { bindFetchSafeLoopbackServer } from "../../src/net/fetch-safe-loopback.js";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";
import type { AliyunFetch } from "../../src/providers/aliyun/types.js";

const MIB = 1024 * 1024;
const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const REMOTE_DIRECTORY: RemoteDirectory = {
  id: "folder-1",
  path: "/openClawShare",
  providerState: { driveId: "drive-resource" },
};
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
  putBodies: Map<number, Buffer>;
  abortedParts: Set<number>;
  events: string[];
  maxConcurrentPuts: () => number;
  close(): Promise<void>;
};

type UploadServerOptions = {
  createResponses?: Array<{ status: number; body: unknown }>;
  completeName?: string;
  failPutPart?: number;
  immediateFailPutPart?: number;
  immediateFailStatus?: number;
  delayPuts?: boolean;
  holdPutsMs?: number;
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function requestBuffer(request: IncomingMessage): Promise<{
  body: Buffer;
  aborted: boolean;
}> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch {
    return { body: Buffer.concat(chunks), aborted: true };
  }
  return { body: Buffer.concat(chunks), aborted: request.aborted };
}

async function startUploadServer(
  options: UploadServerOptions = {},
): Promise<UploadServer> {
  const requests: RecordedRequest[] = [];
  const putSizes = new Map<number, number>();
  const putBodies = new Map<number, Buffer>();
  const abortedParts = new Set<number>();
  const events: string[] = [];
  const sockets = new Set<Socket>();
  const createResponses = [...(options.createResponses ?? [])];
  let activePuts = 0;
  let maximumPuts = 0;
  let baseUrl = "";

  const requestListener: RequestListener = async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", baseUrl);
    const partMatch = /^\/signed\/(?:refreshed-)?(\d+)$/.exec(requestUrl.pathname);
    if (request.method === "PUT" && partMatch !== null) {
      const partNumber = Number(partMatch[1]);
      activePuts += 1;
      maximumPuts = Math.max(maximumPuts, activePuts);
      events.push(`put-${partNumber}-start`);
      request.once("aborted", () => abortedParts.add(partNumber));
      response.once("close", () => {
        if (!response.writableEnded) {
          abortedParts.add(partNumber);
        }
      });
      if (options.immediateFailPutPart === partNumber) {
        await new Promise<void>((resolve) => {
          request.once("data", () => resolve());
          request.once("aborted", () => resolve());
        });
        response.writeHead(options.immediateFailStatus ?? 500);
        response.end("signed-url-secret-CANARY");
        request.resume();
        activePuts -= 1;
        events.push(`put-${partNumber}-end`);
        return;
      }
      const read = await requestBuffer(request);
      putSizes.set(partNumber, read.body.length);
      putBodies.set(partNumber, read.body);
      if (read.aborted) {
        abortedParts.add(partNumber);
      }
      if (options.delayPuts === true) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (options.holdPutsMs !== undefined) {
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, options.holdPutsMs)),
          new Promise((resolve) => response.once("close", resolve)),
        ]);
      }
      activePuts -= 1;
      events.push(`put-${partNumber}-end`);
      if (response.destroyed) {
        abortedParts.add(partNumber);
        return;
      }
      if (options.failPutPart === partNumber) {
        response.writeHead(500);
        response.end("signed-url-secret-CANARY");
        return;
      }
      response.writeHead(200);
      response.end();
      return;
    }

    const { body: bodyBuffer } = await requestBuffer(request);
    const body = bodyBuffer.length === 0
      ? undefined
      : JSON.parse(bodyBuffer.toString("utf8")) as unknown;
    requests.push({
      method: request.method ?? "",
      path: requestUrl.pathname,
      body,
    });

    if (requestUrl.pathname.endsWith("/user/getDriveInfo")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        user_id: "contract-user-id",
        default_drive_id: "drive-default",
        resource_drive_id: "drive-resource",
        backup_drive_id: "drive-backup",
      }));
      return;
    }

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
  baseUrl = `http://127.0.0.1:${address.port}`;

  const fixture: UploadServer = {
    baseUrl,
    requests,
    putSizes,
    putBodies,
    abortedParts,
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
    fetch?: AliyunFetch;
    delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
): AliyunProvider {
  return new AliyunProvider({
    tokenService: { refresh: vi.fn() },
    baseUrl: server.baseUrl,
    tokenManager: {
      forceRefresh: options.forceRefresh ?? (async () => "access-new"),
    },
    clock: options.clock ?? (() => NOW),
    delay: options.delay ?? (async () => undefined),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
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
    const sentinels = [
      [0, "A"],
      [20 * MIB - 1, "B"],
      [20 * MIB, "C"],
      [40 * MIB - 1, "D"],
      [40 * MIB, "E"],
      [45 * MIB - 1, "F"],
    ] as const;
    for (const [position, value] of sentinels) {
      await file.handle.write(Buffer.from(value), 0, 1, position);
    }

    const result = await provider(server).uploadFile({
      accessToken: "access-old",
      remoteDirectory: REMOTE_DIRECTORY,
      file,
    });

    const create = server.requests.find(({ path: requestPath }) =>
      requestPath.endsWith("/openFile/create")
    );
    expect(create?.body).toEqual({
      drive_id: "drive-resource",
      parent_file_id: "folder-1",
      name: "report.bin",
      type: "file",
      check_name_mode: "auto_rename",
      parallel_upload: false,
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
    expect(server.putBodies.get(1)?.subarray(0, 1).toString()).toBe("A");
    expect(server.putBodies.get(1)?.subarray(-1).toString()).toBe("B");
    expect(server.putBodies.get(2)?.subarray(0, 1).toString()).toBe("C");
    expect(server.putBodies.get(2)?.subarray(-1).toString()).toBe("D");
    expect(server.putBodies.get(3)?.subarray(0, 1).toString()).toBe("E");
    expect(server.putBodies.get(3)?.subarray(-1).toString()).toBe("F");
    expect(server.events.at(-1)).toBe("complete");
    expect(server.events.filter((event) => event.endsWith("-end"))).toHaveLength(3);
    expect(result).toEqual({
      remoteName: "report (1).bin",
      size: 45 * MIB,
    });
    await expect(file.handle.stat()).resolves.toMatchObject({ size: 45 * MIB });
  });

  it("uploads multipart PUTs sequentially in ascending order", async () => {
    const server = await startUploadServer({ delayPuts: true });
    const file = await sparseFile(65 * MIB);

    await provider(server).uploadFile({
      accessToken: "access-old",
      remoteDirectory: REMOTE_DIRECTORY,
      file,
    });

    expect(server.putSizes.size).toBe(4);
    expect(server.maxConcurrentPuts()).toBe(1);
    expect(server.events.filter((event) => event.startsWith("put-"))).toEqual([
      "put-1-start",
      "put-1-end",
      "put-2-start",
      "put-2-end",
      "put-3-start",
      "put-3-end",
      "put-4-start",
      "put-4-end",
    ]);
  });

  it("schedules no later part after the first sequential PUT fails", async () => {
    const server = await startUploadServer({
      immediateFailPutPart: 1,
      immediateFailStatus: 429,
      holdPutsMs: 2_000,
    });
    const file = await sparseFile(85 * MIB);
    const startedAt = Date.now();
    const abortedSignedPuts = new Set<string>();
    const trackingFetch: AliyunFetch = async (input, init) => {
      const requestUrl = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const signal = init?.signal;
      if (init?.method === "PUT" && signal != null) {
        const markAborted = () => abortedSignedPuts.add(requestUrl.pathname);
        if (signal.aborted) {
          markAborted();
        } else {
          signal.addEventListener("abort", markAborted, { once: true });
        }
      }
      return globalThis.fetch(input, init);
    };

    const error = await rejectedPanSyncError(() =>
      provider(server, { fetch: trackingFetch }).uploadFile({
        accessToken: "access-old",
        remoteDirectory: REMOTE_DIRECTORY,
        file,
      })
    );
    const elapsedMs = Date.now() - startedAt;

    expect(error.code).toBe("RATE_LIMITED");
    expect(elapsedMs).toBeLessThan(1_500);
    const startedPuts = server.events.filter((event) =>
      event.endsWith("-start")
    );
    expect(startedPuts).toContain("put-1-start");
    expect(startedPuts).toEqual(["put-1-start"]);
    expect(abortedSignedPuts).toEqual(new Set());
    expect(server.events).not.toContain("complete");
    expect(
      server.requests.some(({ path: requestPath }) =>
        requestPath.endsWith("/openFile/complete")
      ),
    ).toBe(false);
    await expect(file.handle.stat()).resolves.toMatchObject({ size: 85 * MIB });
  });

  it("aborts all multipart PUTs from the caller signal and never completes the upload", async () => {
    const server = await startUploadServer({ holdPutsMs: 2_000 });
    const file = await sparseFile(45 * MIB);
    const controller = new AbortController();
    const startedAt = Date.now();
    const uploading = provider(server).uploadFile(
      {
        accessToken: "access-old",
        remoteDirectory: REMOTE_DIRECTORY,
        file,
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(server.events.some((event) => event.endsWith("-start"))).toBe(true);
    });

    controller.abort();

    await expect(uploading).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await vi.waitFor(() => expect(server.abortedParts.size).toBeGreaterThan(0));
    expect(server.events).not.toContain("complete");
    expect(server.requests.some(({ path: requestPath }) =>
      requestPath.endsWith("/openFile/complete")
    )).toBe(false);
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
        remoteDirectory: REMOTE_DIRECTORY,
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

  it("starts adjacent fast PUTs at least 350 ms apart", async () => {
    const server = await startUploadServer();
    const file = await sparseFile(45 * MIB);
    let now = 0;
    const putStartedAt: number[] = [];
    const delays: number[] = [];
    const trackingFetch: AliyunFetch = async (input, init) => {
      if (init?.method === "PUT") {
        putStartedAt.push(now);
      }
      return globalThis.fetch(input, init);
    };

    await provider(server, {
      clock: () => now,
      fetch: trackingFetch,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    }).uploadFile({
      accessToken: "access-old",
      remoteDirectory: REMOTE_DIRECTORY,
      file,
    });

    expect(putStartedAt).toEqual([0, 350, 700]);
    expect(delays).toEqual([350, 350]);
  });

  it("adds no fixed wait when each PUT already takes at least 350 ms", async () => {
    const server = await startUploadServer();
    const file = await sparseFile(45 * MIB);
    let now = 0;
    const delay = vi.fn(async () => undefined);
    const trackingFetch: AliyunFetch = async (input, init) => {
      if (init?.method === "PUT") {
        now += 350;
      }
      return globalThis.fetch(input, init);
    };

    await provider(server, {
      clock: () => now,
      fetch: trackingFetch,
      delay,
    }).uploadFile({
      accessToken: "access-old",
      remoteDirectory: REMOTE_DIRECTORY,
      file,
    });

    expect(delay).not.toHaveBeenCalled();
  });

  it("rejects a represented file requiring parts above the 5 GB limit before create", async () => {
    const server = await startUploadServer();
    const file = await sparseFile(1);
    const representedFile = {
      ...file,
      size: 5 * 1024 * 1024 * 1024 * 10_000 + 1,
    };

    await expect(provider(server).uploadFile({
      accessToken: "access-old",
      remoteDirectory: REMOTE_DIRECTORY,
      file: representedFile,
    })).rejects.toMatchObject({ code: "UPLOAD_FAILED" });

    expect(server.requests).toEqual([]);
  });

  it("creates and completes a zero-byte upload without PUT requests", async () => {
    const server = await startUploadServer({ completeName: "empty.txt" });
    const file = await sparseFile(0, "empty.txt");

    await expect(
      provider(server).uploadFile({
        accessToken: "access-old",
        remoteDirectory: REMOTE_DIRECTORY,
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

  it("uploads through the ProviderRegistry contract without an unsafe downcast", async () => {
    const server = await startUploadServer({ completeName: "contract.txt" });
    const file = await sparseFile(1, "contract.txt");
    const resolved: CloudDriveProvider = new ProviderRegistry(
      [provider(server)],
      "aliyun",
    ).resolve("aliyun");

    const directory = await resolved.ensureDirectory("/", "access-old");
    await expect(resolved.uploadFile({
      accessToken: "access-old",
      remoteDirectory: directory,
      file,
    })).resolves.toEqual({
      remoteName: "contract.txt",
      size: 1,
    });

    expect(directory.providerState).toEqual({ driveId: "drive-resource" });
    expect(
      server.requests
        .filter(({ body }) =>
          typeof body === "object" && body !== null && "drive_id" in body
        )
        .map(({ body }) => (body as { drive_id: unknown }).drive_id),
    ).toEqual(["drive-resource", "drive-resource"]);
    await expect(file.handle.stat()).resolves.toMatchObject({ size: 1 });
  });

  it("refreshes an upload URL at 50 minutes before sending the part", async () => {
    const server = await startUploadServer();
    const file = await sparseFile(1);
    let clockCalls = 0;

    await provider(server, {
      clock: () => clockCalls++ === 0 ? NOW : NOW + 50 * 60 * 1_000,
    }).uploadFile({
      accessToken: "access-old",
      remoteDirectory: REMOTE_DIRECTORY,
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

  it("refreshes a multipart API request without adding Bearer auth to signed part PUTs", async () => {
    const server = await startUploadServer({
      createResponses: [
        { status: 401, body: { code: "AccessTokenExpired" } },
      ],
    });
    const file = await sparseFile(45 * MIB);
    const forceRefresh = vi.fn(async () => "access-new");
    const requests: Array<{
      method: string;
      path: string;
      authorization: string | null;
    }> = [];
    const trackingFetch: AliyunFetch = async (input, init) => {
      const requestUrl = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      requests.push({
        method:
          init?.method ?? (input instanceof Request ? input.method : "GET"),
        path: requestUrl.pathname,
        authorization: new Headers(
          init?.headers
            ?? (input instanceof Request ? input.headers : undefined),
        ).get("authorization"),
      });
      return globalThis.fetch(input, init);
    };

    await provider(server, { forceRefresh, fetch: trackingFetch }).uploadFile({
      accessToken: "access-old",
      remoteDirectory: REMOTE_DIRECTORY,
      file,
    });

    expect(forceRefresh).toHaveBeenCalledOnce();
    expect(forceRefresh).toHaveBeenCalledWith("access-old");
    expect(
      requests
        .filter(({ path: requestPath }) => requestPath.startsWith("/adrive/"))
        .map(({ authorization }) => authorization),
    ).toEqual([
      "Bearer access-old",
      "Bearer access-new",
      "Bearer access-new",
    ]);
    const partPuts = requests.filter(({ method }) => method === "PUT");
    expect(partPuts).toHaveLength(3);
    expect(partPuts.every(({ path: requestPath, authorization }) =>
      requestPath.startsWith("/signed/") && authorization === null
    )).toBe(true);
  });

  it("maps a second explicit file-creation token failure to AUTHORIZATION_REVOKED", async () => {
    const server = await startUploadServer({
      createResponses: [
        { status: 401, body: { code: "AccessTokenInvalid" } },
        { status: 400, body: { code: "AccessTokenExpired" } },
      ],
    });
    const file = await sparseFile(1);
    const forceRefresh = vi.fn(async () => "access-new");

    const error = await rejectedPanSyncError(() =>
      provider(server, { forceRefresh }).uploadFile({
        accessToken: "access-old",
        remoteDirectory: REMOTE_DIRECTORY,
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
        remoteDirectory: REMOTE_DIRECTORY,
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
        remoteDirectory: REMOTE_DIRECTORY,
        file,
      })
    );

    expect(error.code).toBe("UPLOAD_FAILED");
    expect(error.message).toBe("UPLOAD_FAILED");
    expect(error.message).not.toContain("upload-url-CANARY");
    expect(error.message).not.toContain("/signed/");
    await expect(file.handle.stat()).resolves.toMatchObject({ size: 1 });
    expect(server.events).not.toContain("complete");
  });

  it("maps a short descriptor read to UPLOAD_FAILED without completing", async () => {
    const server = await startUploadServer();
    const file = await sparseFile(1, "truncated.bin");
    const representedFile = { ...file, size: 2 };

    const error = await rejectedPanSyncError(() =>
      provider(server).uploadFile({
        accessToken: "access-old",
        remoteDirectory: REMOTE_DIRECTORY,
        file: representedFile,
      })
    );

    expect(error.code).toBe("UPLOAD_FAILED");
    expect(server.events).not.toContain("complete");
    expect(
      server.requests.some(({ path: requestPath }) =>
        requestPath.endsWith("/openFile/complete")
      ),
    ).toBe(false);
    await expect(file.handle.stat()).resolves.toMatchObject({ size: 1 });
  });
});
