import { timingSafeEqual } from "node:crypto";
import {
  createServer as nodeCreateServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { chmod, type FileHandle, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { CredentialInput } from "../contracts.js";
import type { CredentialStore } from "../credentials/store.js";
import type { CredentialRecord } from "../credentials/types.js";
import { PanSyncError, safeErrorDetails } from "../errors.js";
import {
  DEFAULT_OPENLIST_AUTHORIZATION_PAGE_URL,
  DEFAULT_OPENLIST_REFRESH_API_URL,
} from "../providers/aliyun/constants.js";
import type { AliyunProvider } from "../providers/aliyun/provider.js";
import type { UploadOrchestrator } from "../upload/orchestrator.js";
import { readSetupPageAssets } from "./setup-page.js";

const ACCESS_KEY_BYTES = 32;
const AUTHORIZATION_PATTERN = /^PanSyncSetup ([A-Za-z0-9_-]{43})$/u;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CREDENTIAL_FIELD_LENGTH = 4096;
const SETUP_LIFETIME_MS = 10 * 60 * 1_000;
const REQUEST_LIFETIME_MS = 15 * 1_000;
const RESULT_DISPLAY_MS = 60 * 1_000;
const DEFAULT_REMOTE_DIRECTORY = "/openClawShare";
const LOOPBACK_HOST = "127.0.0.1";
const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export const SETUP_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;

type SetupCredentialStore = Pick<CredentialStore, "read" | "replaceIfVersion" | "clear">;
type SetupProvider = Pick<AliyunProvider, "validateCredentials">;
type SetupOrchestrator = Pick<UploadOrchestrator, "upload">;

export type SetupServerDependencies = {
  store: SetupCredentialStore;
  provider: SetupProvider;
  orchestrator: SetupOrchestrator;
  dataDir: string;
  assetsDir: string;
  clock: () => number;
  randomBytes: (size: number) => Buffer;
  defaultDirectory?: string | undefined;
};

export type SetupServerRuntime = {
  port?: number;
  createServer?: (handler: RequestListener) => Server;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (timeout: unknown) => void;
  scheduleRequestTimeout?: (callback: () => void, delay: number) => unknown;
  cancelRequestTimeout?: (timeout: unknown) => void;
  removeTemporaryDirectory?: (directory: string) => Promise<void>;
  temporaryFiles?: Partial<SetupTemporaryFileAdapter>;
  isBrowserSafePort?: (port: number) => boolean;
};

export type SetupTemporaryFileAdapter = {
  chmod(target: string, mode: number): Promise<void>;
  lstat(target: string): Promise<Stats>;
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  open(target: string, flags: string, mode: number): Promise<FileHandle>;
  realpath(target: string): Promise<string>;
};

const defaultTemporaryFiles: SetupTemporaryFileAdapter = {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
};

export type SetupServer = {
  url: string;
  port: number;
  accessKeyBuffer: Buffer;
  closed: Promise<void>;
  close(): Promise<void>;
  isAuthorized(authorization: string | undefined): boolean;
};

const BODY_TOO_LARGE = Symbol("BODY_TOO_LARGE");
class SetupConflictError extends Error {}
class RequestTimeoutError extends Error {}
class SetupClosedError extends Error {}

type RequestContext = {
  controller: AbortController;
  generation: number;
};

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SETUP_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function sendEmpty(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.end();
}

function hasForwardingHeaders(request: IncomingMessage): boolean {
  return Object.keys(request.headers).some(
    (name) => name === "forwarded" || name.startsWith("x-forwarded-"),
  );
}

function isAllowedHost(host: string | undefined, port: number | undefined): boolean {
  return port !== undefined && host === `${LOOPBACK_HOST}:${port}`;
}

function parsePathname(request: IncomingMessage): string | undefined {
  const target = request.url;
  const host = request.headers.host;
  if (target === undefined || !target.startsWith("/") || target.startsWith("//") || host === undefined) {
    return undefined;
  }
  try {
    const url = new URL(target, `http://${host}`);
    return url.search.length === 0 ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new SetupClosedError();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<Buffer | typeof BODY_TOO_LARGE> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    request.pause();
    return BODY_TOO_LARGE;
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const wipe = (): void => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (value: Buffer | typeof BODY_TOO_LARGE): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      wipe();
      reject(abortError(signal));
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      wipe();
      reject(error);
    };
    const onEnd = (): void => {
      const body = Buffer.concat(chunks, total);
      wipe();
      settle(body);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
      if (Buffer.isBuffer(chunk)) chunk.fill(0);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        buffer.fill(0);
        wipe();
        request.pause();
        settle(BODY_TOO_LARGE);
      } else {
        chunks.push(buffer);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
  });
}

function readJson(body: Buffer, contentType: string | undefined): unknown {
  try {
    if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
      throw Object.assign(new Error("unsupported media type"), { statusCode: 415 });
    }
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
      throw Object.assign(new Error("unsupported media type"), { statusCode: 415 });
    }
    throw new PanSyncError("CREDENTIALS_INVALID");
  } finally {
    body.fill(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredentialInput(value: unknown): Omit<CredentialInput, "credentialVersion"> {
  if (!isRecord(value)) throw new PanSyncError("CREDENTIALS_INVALID");
  const allowed = new Set(["authorizationPageUrl", "refreshApiUrl", "refreshToken"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new PanSyncError("CREDENTIALS_INVALID");
  const { authorizationPageUrl, refreshApiUrl, refreshToken } = value;
  for (const field of [authorizationPageUrl, refreshApiUrl, refreshToken]) {
    if (typeof field !== "string" || field.trim().length === 0 || field.length > MAX_CREDENTIAL_FIELD_LENGTH) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }
  }
  try {
    new URL(authorizationPageUrl as string);
    new URL(refreshApiUrl as string);
  } catch {
    throw new PanSyncError("CREDENTIALS_INVALID");
  }
  return {
    authorizationPageUrl: authorizationPageUrl as string,
    refreshApiUrl: refreshApiUrl as string,
    refreshToken: refreshToken as string,
  };
}

function projectRecord(record: CredentialRecord | undefined, dependencies: SetupServerDependencies): unknown {
  const defaultDirectory = dependencies.defaultDirectory ?? DEFAULT_REMOTE_DIRECTORY;
  if (record === undefined) {
    return {
      configured: false,
      credentials: {
        authorizationPageUrl: DEFAULT_OPENLIST_AUTHORIZATION_PAGE_URL,
        refreshApiUrl: DEFAULT_OPENLIST_REFRESH_API_URL,
        refreshToken: "",
      },
      defaultDirectory,
    };
  }
  return {
    configured: true,
    credentials: {
      authorizationPageUrl: record.authorizationPageUrl,
      refreshApiUrl: record.refreshApiUrl,
      refreshToken: record.refreshToken,
    },
    account: record.account,
    lastVerifiedAt: record.lastVerifiedAt,
    defaultDirectory,
  };
}

function isBrowserSafePort(port: number): boolean {
  return port >= 1 && port <= 65_535 && !FETCH_FORBIDDEN_PORTS.has(port);
}

function closeListeningServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function safeFailure(error: unknown): { status: number; body: { code: string } } {
  if (error instanceof SetupConflictError) return { status: 409, body: { code: "CREDENTIALS_INVALID" } };
  const details = safeErrorDetails(error);
  const status = details.code === "TOKEN_ENDPOINT_UNAVAILABLE" || details.code === "RATE_LIMITED" ? 503 : 400;
  return { status, body: details };
}

function waitUntilListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

export async function startSetupServer(
  dependencies: SetupServerDependencies,
  runtime: SetupServerRuntime = {},
): Promise<SetupServer> {
  const assets = await readSetupPageAssets(dependencies.assetsDir);
  const generatedKey = dependencies.randomBytes(ACCESS_KEY_BYTES);
  if (generatedKey.length !== ACCESS_KEY_BYTES) {
    generatedKey.fill(0);
    throw new Error("setup access key generation failed");
  }
  const accessKeyBuffer = Buffer.from(generatedKey);
  const oneTimeKey = accessKeyBuffer.toString("base64url");
  const accessKeyAscii = Buffer.from(oneTimeKey, "ascii");
  generatedKey.fill(0);
  const expiresAt = dependencies.clock() + SETUP_LIFETIME_MS;
  const createServer = runtime.createServer ?? nodeCreateServer;
  const scheduleTimeout = runtime.scheduleTimeout ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const cancelTimeout = runtime.cancelTimeout ?? ((timeout: unknown) => clearTimeout(timeout as NodeJS.Timeout));
  const scheduleRequestTimeout = runtime.scheduleRequestTimeout ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const cancelRequestTimeout = runtime.cancelRequestTimeout ?? ((timeout: unknown) => clearTimeout(timeout as NodeJS.Timeout));
  const temporaryFiles: SetupTemporaryFileAdapter = {
    ...defaultTemporaryFiles,
    ...runtime.temporaryFiles,
  };
  const removeTemporaryDirectory = runtime.removeTemporaryDirectory
    ?? ((directory: string) => rm(directory, { recursive: true, force: false }));
  let active = true;
  let authorizationGeneration = 0;
  let closing: Promise<void> | undefined;
  let expiryTimeout: unknown;
  let resultTimeout: unknown;
  let selectedPort: number | undefined;
  const activeRequests = new Set<RequestContext>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const matchesAuthorization = (authorization: string | undefined): boolean => {
    if (authorization === undefined) return false;
    const match = AUTHORIZATION_PATTERN.exec(authorization);
    if (match?.[1] === undefined) return false;
    const candidate = Buffer.from(match[1], "ascii");
    try {
      return candidate.length === accessKeyAscii.length && timingSafeEqual(candidate, accessKeyAscii);
    } finally {
      candidate.fill(0);
    }
  };
  const isAuthorized = (authorization: string | undefined): boolean =>
    active && dependencies.clock() < expiresAt && matchesAuthorization(authorization);
  const assertAuthorized = (context: RequestContext, authorization: string | undefined): void => {
    if (
      context.controller.signal.aborted
      || !active
      || context.generation !== authorizationGeneration
      || dependencies.clock() >= expiresAt
      || !matchesAuthorization(authorization)
    ) throw new SetupClosedError();
  };

  let server!: Server;
  const close = async (): Promise<void> => {
    if (closing !== undefined) return closing;
    active = false;
    authorizationGeneration += 1;
    accessKeyBuffer.fill(0);
    accessKeyAscii.fill(0);
    if (expiryTimeout !== undefined) cancelTimeout(expiryTimeout);
    if (resultTimeout !== undefined) cancelTimeout(resultTimeout);
    for (const context of activeRequests) context.controller.abort(new SetupClosedError());
    closing = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolveClosed();
        resolve();
        return;
      }
      server.close(() => { resolveClosed(); resolve(); });
      server.closeAllConnections();
    });
    return closing;
  };

  const scheduleResultClose = (): void => {
    if (resultTimeout !== undefined) cancelTimeout(resultTimeout);
    resultTimeout = scheduleTimeout(() => { void close(); }, RESULT_DISPLAY_MS);
  };

  const validateAndReplace = async (
    context: RequestContext,
    authorization: string | undefined,
    candidate: Omit<CredentialInput, "credentialVersion">,
    knownCurrent?: CredentialRecord,
  ): Promise<CredentialRecord> => {
    const signal = context.controller.signal;
    const current = knownCurrent ?? await abortable(dependencies.store.read(), signal);
    assertAuthorized(context, authorization);
    const validated = await abortable(dependencies.provider.validateCredentials(
      {
        ...candidate,
        credentialVersion: (current?.credentialVersion ?? 0) + 1,
      },
      { signal },
    ), signal);
    assertAuthorized(context, authorization);
    if (!await abortable(dependencies.store.replaceIfVersion(current?.credentialVersion, validated, { signal }), signal)) {
      throw new SetupConflictError();
    }
    assertAuthorized(context, authorization);
    return validated;
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    body: Buffer,
    context: RequestContext,
  ): Promise<boolean> => {
    const method = request.method ?? "GET";
    const isKnown =
      (pathname === "/api/config" && ["GET", "PUT", "DELETE"].includes(method))
      || (pathname === "/api/revalidate" && method === "POST")
      || (pathname === "/api/test-upload" && method === "POST");
    if (!isKnown) return false;
    const authorization = Array.isArray(request.headers.authorization) ? undefined : request.headers.authorization;
    if (!isAuthorized(authorization)) {
      sendJson(response, 401, { code: "CREDENTIALS_REQUIRED" });
      return true;
    }
    try {
      assertAuthorized(context, authorization);
      if (method === "POST" && body.length !== 0) throw new PanSyncError("CREDENTIALS_INVALID");
      if (pathname === "/api/config" && method === "GET") {
        const record = await abortable(dependencies.store.read(), context.controller.signal);
        assertAuthorized(context, authorization);
        sendJson(response, 200, projectRecord(record, dependencies));
        return true;
      }
      if (pathname === "/api/config" && method === "PUT") {
        const value = readJson(body, Array.isArray(request.headers["content-type"]) ? undefined : request.headers["content-type"]);
        const record = await validateAndReplace(context, authorization, parseCredentialInput(value));
        assertAuthorized(context, authorization);
        sendJson(response, 200, projectRecord(record, dependencies));
        scheduleResultClose();
        return true;
      }
      if (pathname === "/api/config" && method === "DELETE") {
        const value = readJson(body, Array.isArray(request.headers["content-type"]) ? undefined : request.headers["content-type"]);
        if (!isRecord(value) || Object.keys(value).length !== 1 || value.confirm !== "CLEAR") throw new PanSyncError("CREDENTIALS_INVALID");
        assertAuthorized(context, authorization);
        await abortable(dependencies.store.clear({ signal: context.controller.signal }), context.controller.signal);
        assertAuthorized(context, authorization);
        sendJson(response, 200, projectRecord(undefined, dependencies));
        scheduleResultClose();
        return true;
      }
      if (pathname === "/api/revalidate") {
        const current = await abortable(dependencies.store.read(), context.controller.signal);
        assertAuthorized(context, authorization);
        if (current === undefined) throw new PanSyncError("CREDENTIALS_REQUIRED");
        const record = await validateAndReplace(context, authorization, {
          authorizationPageUrl: current.authorizationPageUrl,
          refreshApiUrl: current.refreshApiUrl,
          refreshToken: current.refreshToken,
        }, current);
        assertAuthorized(context, authorization);
        sendJson(response, 200, projectRecord(record, dependencies));
        return true;
      }

      const uploadResult = await abortable((async () => {
        await temporaryFiles.mkdir(dependencies.dataDir, { recursive: true, mode: 0o700 });
        await temporaryFiles.chmod(dependencies.dataDir, 0o700);
        const confinedDataDir = await temporaryFiles.realpath(dependencies.dataDir);
        const temporaryRoot = path.join(confinedDataDir, "tmp");
        await temporaryFiles.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
        const temporaryRootStat = await temporaryFiles.lstat(temporaryRoot);
        if (temporaryRootStat.isSymbolicLink() || !temporaryRootStat.isDirectory()) {
          throw new PanSyncError("UPLOAD_FAILED");
        }
        const confinedTemporaryRoot = await temporaryFiles.realpath(temporaryRoot);
        if (path.dirname(confinedTemporaryRoot) !== confinedDataDir) {
          throw new PanSyncError("UPLOAD_FAILED");
        }
        await temporaryFiles.chmod(confinedTemporaryRoot, 0o700);
        const workspaceDir = await temporaryFiles.mkdtemp(path.join(confinedTemporaryRoot, "pan-sync-test-"));
        try {
          await temporaryFiles.chmod(workspaceDir, 0o700);
          const filename = "payload.txt";
          const temporaryPath = path.join(workspaceDir, filename);
          const source = dependencies.randomBytes(32);
          if (source.length !== 32) throw new PanSyncError("UPLOAD_FAILED");
          const payload = Buffer.from(`${source.toString("base64url")}\n`, "ascii");
          source.fill(0);
          try {
            const handle = await temporaryFiles.open(temporaryPath, "wx", 0o600);
            try {
              await handle.writeFile(payload);
              await handle.sync();
            } finally {
              await handle.close();
            }
          } finally {
            payload.fill(0);
          }
          const uploaded = await dependencies.orchestrator.upload(
            {
              paths: [filename],
              remoteDirectory: DEFAULT_REMOTE_DIRECTORY,
              workspaceDir,
            },
            { signal: context.controller.signal },
          );
          const file = uploaded.files.find((entry) => entry.status === "uploaded");
          if (file?.remoteName === undefined || uploaded.status === "failed") {
            throw new PanSyncError("UPLOAD_FAILED");
          }
          return { remoteName: file.remoteName, remoteDirectory: uploaded.remoteDirectory };
        } finally {
          await removeTemporaryDirectory(workspaceDir);
        }
      })(), context.controller.signal);
      assertAuthorized(context, authorization);
      sendJson(response, 200, uploadResult);
      return true;
    } catch (error) {
      if (error instanceof SetupClosedError || context.controller.signal.aborted) throw error;
      if ((error as { statusCode?: unknown }).statusCode === 415) {
        sendJson(response, 415, { code: "CREDENTIALS_INVALID" });
      } else {
        const failure = safeFailure(error);
        sendJson(response, failure.status, failure.body);
      }
      return true;
    }
  };

  const requestListener: RequestListener = (request, response) => {
    setSecurityHeaders(response);
    const context: RequestContext = { controller: new AbortController(), generation: authorizationGeneration };
    activeRequests.add(context);
    const requestTimeout = scheduleRequestTimeout(() => context.controller.abort(new RequestTimeoutError()), REQUEST_LIFETIME_MS);
    void (async () => {
      try {
        const body = await readBody(request, context.controller.signal);
        if (body === BODY_TOO_LARGE) {
          response.setHeader("Connection", "close");
          sendJson(response, 413, { code: "CREDENTIALS_INVALID" });
          return;
        }
        try {
          if (hasForwardingHeaders(request) || !isAllowedHost(request.headers.host, selectedPort)) {
            sendJson(response, 400, { code: "CREDENTIALS_INVALID" });
            return;
          }
          const pathname = parsePathname(request);
          if (pathname === undefined) { sendEmpty(response, 400); return; }
          if (request.method === "GET") {
            const asset = assets.get(pathname);
            if (asset !== undefined) {
              response.statusCode = 200;
              response.setHeader("Content-Type", asset.contentType);
              response.end(asset.body);
              return;
            }
          }
          if (await handleApi(request, response, pathname, body, context)) return;
          sendEmpty(response, 404);
        } finally {
          body.fill(0);
        }
      } catch (error) {
        if (error instanceof RequestTimeoutError) {
          response.setHeader("Connection", "close");
          sendJson(response, 408, { code: "CREDENTIALS_INVALID" });
        } else if (error instanceof SetupClosedError || context.controller.signal.aborted) {
          response.destroy();
          request.destroy();
        } else if (!response.headersSent) {
          sendJson(response, 500, { code: "UPLOAD_FAILED" });
        } else {
          response.destroy();
        }
      } finally {
        activeRequests.delete(context);
        cancelRequestTimeout(requestTimeout);
      }
    })();
  };

  const portIsSafe = runtime.isBrowserSafePort ?? isBrowserSafePort;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      server = createServer(requestListener);
      server.listen(runtime.port ?? 0, LOOPBACK_HOST);
      await waitUntilListening(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        await closeListeningServer(server);
        throw new Error("setup server address unavailable");
      }
      if (portIsSafe(address.port)) { selectedPort = address.port; break; }
      await closeListeningServer(server);
      if (runtime.port !== undefined && runtime.port !== 0) throw new Error("setup server port rejected by browsers");
    }
  } catch (error) {
    accessKeyBuffer.fill(0);
    accessKeyAscii.fill(0);
    throw error;
  }
  if (selectedPort === undefined) {
    accessKeyBuffer.fill(0);
    accessKeyAscii.fill(0);
    throw new Error("setup server could not select a browser-safe port");
  }
  server.once("close", () => {
    active = false;
    accessKeyBuffer.fill(0);
    accessKeyAscii.fill(0);
    resolveClosed();
  });
  expiryTimeout = scheduleTimeout(() => { void close(); }, SETUP_LIFETIME_MS);

  return {
    url: `http://${LOOPBACK_HOST}:${selectedPort}/#${oneTimeKey}`,
    port: selectedPort,
    accessKeyBuffer,
    closed,
    close,
    isAuthorized,
  };
}
