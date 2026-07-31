import { timingSafeEqual } from "node:crypto";
import {
  createServer as nodeCreateServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { CredentialInput } from "../contracts.js";
import type { CredentialStore } from "../credentials/store.js";
import type { CredentialRecord } from "../credentials/types.js";
import { PanSyncError, safeErrorDetails } from "../errors.js";
import type { AliyunProvider } from "../providers/aliyun/provider.js";
import type { UploadOrchestrator } from "../upload/orchestrator.js";
import { readSetupPageAssets } from "./setup-page.js";

const ACCESS_KEY_BYTES = 32;
const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const AUTHORIZATION_PATTERN = /^PanSyncSetup ([A-Za-z0-9_-]{43})$/u;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CREDENTIAL_FIELD_LENGTH = 4096;
const SETUP_LIFETIME_MS = 10 * 60 * 1_000;
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

type SetupCredentialStore = Pick<
  CredentialStore,
  "read" | "replace" | "replaceIfVersion" | "clear"
>;
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
  tokenGuideUrl?: string | undefined;
};

export type SetupServerRuntime = {
  port?: number;
  createServer?: (handler: RequestListener) => Server;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (timeout: unknown) => void;
  isBrowserSafePort?: (port: number) => boolean;
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

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SETUP_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

function hasForwardingHeaders(request: IncomingMessage): boolean {
  return Object.keys(request.headers).some(
    (name) => name === "forwarded" || name.startsWith("x-forwarded-"),
  );
}

function isAllowedHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/u.test(host);
}

function parsePathname(request: IncomingMessage): string | undefined {
  const target = request.url;
  const host = request.headers.host;
  if (
    target === undefined
    || !target.startsWith("/")
    || target.startsWith("//")
    || host === undefined
  ) {
    return undefined;
  }
  try {
    const url = new URL(target, `http://${host}`);
    if (url.search.length > 0) {
      return undefined;
    }
    return url.pathname;
  } catch {
    return undefined;
  }
}

async function readBody(
  request: IncomingMessage,
): Promise<Buffer | typeof BODY_TOO_LARGE> {
  const contentLength = request.headers["content-length"];
  if (
    typeof contentLength === "string"
    && /^\d+$/u.test(contentLength)
    && Number(contentLength) > MAX_BODY_BYTES
  ) {
    request.resume();
    return BODY_TOO_LARGE;
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finishTooLarge = (): void => {
      if (!settled) {
        settled = true;
        request.removeListener("error", reject);
        request.removeListener("end", finish);
        request.removeListener("data", onData);
        request.resume();
        resolve(BODY_TOO_LARGE);
      }
    };
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks, total));
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        chunks.length = 0;
        finishTooLarge();
        return;
      }
      chunks.push(buffer);
    };
    request.on("data", onData);
    request.once("end", finish);
    request.once("error", reject);
  });
}

async function readJson(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | typeof BODY_TOO_LARGE> {
  const body = await readBody(request);
  if (body === BODY_TOO_LARGE) {
    sendJson(response, 413, { code: "CREDENTIALS_INVALID" });
    return BODY_TOO_LARGE;
  }
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new PanSyncError("CREDENTIALS_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredentialInput(value: unknown): Omit<CredentialInput, "credentialVersion"> {
  if (!isRecord(value)) {
    throw new PanSyncError("CREDENTIALS_INVALID");
  }
  const allowed = new Set(["clientId", "clientSecret", "refreshToken"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new PanSyncError("CREDENTIALS_INVALID");
  }
  const clientId = value.clientId;
  const clientSecret = value.clientSecret;
  const refreshToken = value.refreshToken;
  for (const field of [clientId, clientSecret, refreshToken]) {
    if (
      typeof field !== "string"
      || field.trim().length === 0
      || field.length > MAX_CREDENTIAL_FIELD_LENGTH
    ) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }
  }
  return {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    refreshToken: refreshToken as string,
  };
}

function safeTokenGuideUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function projectRecord(
  record: CredentialRecord | undefined,
  dependencies: SetupServerDependencies,
): unknown {
  const defaultDirectory = dependencies.defaultDirectory
    ?? DEFAULT_REMOTE_DIRECTORY;
  const tokenGuideUrl = safeTokenGuideUrl(dependencies.tokenGuideUrl);
  if (record === undefined) {
    return {
      configured: false,
      defaultDirectory,
      ...(tokenGuideUrl === undefined ? {} : { tokenGuideUrl }),
    };
  }
  return {
    configured: true,
    credentials: {
      clientId: record.clientId,
      clientSecret: record.clientSecret,
      refreshToken: record.refreshToken,
    },
    account: record.account,
    lastVerifiedAt: record.lastVerifiedAt,
    defaultDirectory,
    ...(tokenGuideUrl === undefined ? {} : { tokenGuideUrl }),
  };
}

function isBrowserSafePort(port: number): boolean {
  return port >= 1 && port <= 65_535 && !FETCH_FORBIDDEN_PORTS.has(port);
}

function closeListeningServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function safeFailure(error: unknown): { status: number; body: { code: string } } {
  if (error instanceof SetupConflictError) {
    return { status: 409, body: { code: "CREDENTIALS_INVALID" } };
  }
  const details = safeErrorDetails(error);
  const status = details.code === "TOKEN_ENDPOINT_UNAVAILABLE"
    || details.code === "RATE_LIMITED"
    ? 503
    : 400;
  return { status, body: details };
}

function decodeAccessKey(value: string): Buffer | undefined {
  if (!ACCESS_KEY_PATTERN.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === ACCESS_KEY_BYTES ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function waitUntilListening(server: Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }
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
  });
}

export async function startSetupServer(
  dependencies: SetupServerDependencies,
  runtime: SetupServerRuntime = {},
): Promise<SetupServer> {
  const assets = await readSetupPageAssets(dependencies.assetsDir);
  const generatedKey = dependencies.randomBytes(ACCESS_KEY_BYTES);
  if (generatedKey.length !== ACCESS_KEY_BYTES) {
    throw new Error("setup access key generation failed");
  }
  const accessKeyBuffer = Buffer.from(generatedKey);
  const oneTimeKey = accessKeyBuffer.toString("base64url");
  const expiresAt = dependencies.clock() + SETUP_LIFETIME_MS;
  const createServer = runtime.createServer ?? nodeCreateServer;
  const scheduleTimeout = runtime.scheduleTimeout
    ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const cancelTimeout = runtime.cancelTimeout
    ?? ((timeout: unknown) => clearTimeout(timeout as NodeJS.Timeout));
  let active = true;
  let closing: Promise<void> | undefined;
  let expiryTimeout: unknown;
  let resultTimeout: unknown;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const isAuthorized = (authorization: string | undefined): boolean => {
    if (!active || dependencies.clock() >= expiresAt || authorization === undefined) {
      return false;
    }
    const match = AUTHORIZATION_PATTERN.exec(authorization);
    const candidate = match?.[1] === undefined
      ? undefined
      : decodeAccessKey(match[1]);
    return candidate !== undefined && timingSafeEqual(candidate, accessKeyBuffer);
  };

  let server!: Server;
  const close = async (): Promise<void> => {
    if (closing !== undefined) {
      return closing;
    }
    active = false;
    accessKeyBuffer.fill(0);
    if (expiryTimeout !== undefined) {
      cancelTimeout(expiryTimeout);
    }
    if (resultTimeout !== undefined) {
      cancelTimeout(resultTimeout);
    }
    closing = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolveClosed();
        resolve();
        return;
      }
      server.close(() => {
        resolveClosed();
        resolve();
      });
    });
    return closing;
  };

  const scheduleResultClose = (): void => {
    if (resultTimeout !== undefined) {
      cancelTimeout(resultTimeout);
    }
    resultTimeout = scheduleTimeout(() => {
      void close();
    }, RESULT_DISPLAY_MS);
  };

  const validateAndReplace = async (
    candidate: Omit<CredentialInput, "credentialVersion">,
    knownCurrent?: CredentialRecord,
  ): Promise<CredentialRecord> => {
    const current = knownCurrent ?? await dependencies.store.read();
    const validated = await dependencies.provider.validateCredentials({
      ...candidate,
      credentialVersion: (current?.credentialVersion ?? 0) + 1,
    });
    if (current === undefined) {
      await dependencies.store.replace(validated);
    } else if (
      !await dependencies.store.replaceIfVersion(
        current.credentialVersion,
        validated,
      )
    ) {
      throw new SetupConflictError();
    }
    return validated;
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> => {
    const method = request.method ?? "GET";
    const isKnown =
      (pathname === "/api/config" && ["GET", "PUT", "DELETE"].includes(method))
      || (pathname === "/api/revalidate" && method === "POST")
      || (pathname === "/api/test-upload" && method === "POST");
    if (!isKnown) {
      return false;
    }
    const authorization = Array.isArray(request.headers.authorization)
      ? undefined
      : request.headers.authorization;
    if (!isAuthorized(authorization)) {
      sendJson(response, 401, { code: "CREDENTIALS_REQUIRED" });
      return true;
    }

    try {
      if (method === "POST") {
        const body = await readBody(request);
        if (body === BODY_TOO_LARGE) {
          sendJson(response, 413, { code: "CREDENTIALS_INVALID" });
          return true;
        }
      }
      if (pathname === "/api/config" && method === "GET") {
        sendJson(
          response,
          200,
          projectRecord(await dependencies.store.read(), dependencies),
        );
        return true;
      }
      if (pathname === "/api/config" && method === "PUT") {
        const value = await readJson(request, response);
        if (value === BODY_TOO_LARGE) {
          return true;
        }
        const record = await validateAndReplace(parseCredentialInput(value));
        sendJson(response, 200, projectRecord(record, dependencies));
        scheduleResultClose();
        return true;
      }
      if (pathname === "/api/config" && method === "DELETE") {
        const value = await readJson(request, response);
        if (value === BODY_TOO_LARGE) {
          return true;
        }
        if (
          !isRecord(value)
          || Object.keys(value).length !== 1
          || value.confirm !== "CLEAR"
        ) {
          throw new PanSyncError("CREDENTIALS_INVALID");
        }
        await dependencies.store.clear();
        sendJson(response, 200, projectRecord(undefined, dependencies));
        scheduleResultClose();
        return true;
      }
      if (pathname === "/api/revalidate") {
        const current = await dependencies.store.read();
        if (current === undefined) {
          throw new PanSyncError("CREDENTIALS_REQUIRED");
        }
        const record = await validateAndReplace({
          clientId: current.clientId,
          clientSecret: current.clientSecret,
          refreshToken: current.refreshToken,
        }, current);
        sendJson(response, 200, projectRecord(record, dependencies));
        return true;
      }

      const temporaryDirectory = path.join(dependencies.dataDir, "tmp");
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await chmod(temporaryDirectory, 0o700);
      const filename = `pan-sync-test-${dependencies.randomBytes(16).toString("hex")}.txt`;
      const temporaryPath = path.join(temporaryDirectory, filename);
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(dependencies.randomBytes(32));
          await handle.sync();
        } finally {
          await handle.close();
        }
        const uploaded = await dependencies.orchestrator.upload({
          paths: [filename],
          remoteDirectory: DEFAULT_REMOTE_DIRECTORY,
          workspaceDir: temporaryDirectory,
        });
        const file = uploaded.files.find((entry) => entry.status === "uploaded");
        if (file?.remoteName === undefined || uploaded.status === "failed") {
          throw new PanSyncError("UPLOAD_FAILED");
        }
        sendJson(response, 200, {
          remoteName: file.remoteName,
          remoteDirectory: uploaded.remoteDirectory,
        });
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      return true;
    } catch (error) {
      const failure = safeFailure(error);
      sendJson(response, failure.status, failure.body);
      return true;
    }
  };

  const requestListener: RequestListener = (request, response) => {
    setSecurityHeaders(response);
    void (async () => {
      if (hasForwardingHeaders(request) || !isAllowedHost(request.headers.host)) {
        sendJson(response, 400, { code: "CREDENTIALS_INVALID" });
        return;
      }
      const pathname = parsePathname(request);
      if (pathname === undefined) {
        sendEmpty(response, 400);
        return;
      }
      if (request.method === "GET") {
        const asset = assets.get(pathname);
        if (asset !== undefined) {
          response.statusCode = 200;
          response.setHeader("Content-Type", asset.contentType);
          response.end(asset.body);
          return;
        }
      }
      if (await handleApi(request, response, pathname)) {
        return;
      }
      sendEmpty(response, 404);
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { code: "UPLOAD_FAILED" });
      } else {
        response.destroy();
      }
    });
  };
  const portIsSafe = runtime.isBrowserSafePort ?? isBrowserSafePort;
  let port: number | undefined;
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
      if (portIsSafe(address.port)) {
        port = address.port;
        break;
      }
      await closeListeningServer(server);
      if (runtime.port !== undefined && runtime.port !== 0) {
        throw new Error("setup server port rejected by browsers");
      }
    }
  } catch (error) {
    accessKeyBuffer.fill(0);
    throw error;
  }
  if (port === undefined) {
    accessKeyBuffer.fill(0);
    throw new Error("setup server could not select a browser-safe port");
  }
  server.once("close", () => {
    active = false;
    accessKeyBuffer.fill(0);
    resolveClosed();
  });
  expiryTimeout = scheduleTimeout(() => {
    void close();
  }, SETUP_LIFETIME_MS);

  return {
    url: `http://${LOOPBACK_HOST}:${port}/#${oneTimeKey}`,
    port,
    accessKeyBuffer,
    closed,
    close,
    isAuthorized,
  };
}
