import { Buffer } from "node:buffer";
import type { PanSyncListResult, ProviderId } from "../contracts.js";
import { PanSyncError } from "../errors.js";

const MAX_CURSOR_BYTES = 65_536;
const MAX_PENDING_DIRECTORIES = 512;
const MAX_BUFFERED_MATCHES = 100;
const CONTROL_CHARACTER = /\p{Cc}/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export type SearchIdentity = {
  provider: ProviderId;
  remoteDirectory: string;
  query: string;
  limit: number;
};

export type SearchCursorState = {
  v: 1;
  identity: SearchIdentity;
  pending: Array<{
    id: string;
    path: string;
    marker?: string;
  }>;
  buffered: PanSyncListResult["entries"];
};

type JsonRecord = Record<string, unknown>;

function invalidCursor(): PanSyncError {
  return new PanSyncError("REMOTE_DIRECTORY_FAILED");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function safeString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !CONTROL_CHARACTER.test(value);
}

function projectIdentity(value: unknown): SearchIdentity {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["provider", "remoteDirectory", "query", "limit"])
    || value.provider !== "aliyun"
    || !safeString(value.remoteDirectory)
    || typeof value.query !== "string"
    || CONTROL_CHARACTER.test(value.query)
    || !Number.isSafeInteger(value.limit)
    || (value.limit as number) < 1
    || (value.limit as number) > 100
  ) {
    throw invalidCursor();
  }
  return {
    provider: value.provider,
    remoteDirectory: value.remoteDirectory,
    query: value.query,
    limit: value.limit as number,
  };
}

function projectPending(value: unknown): SearchCursorState["pending"] {
  if (!Array.isArray(value) || value.length > MAX_PENDING_DIRECTORIES) {
    throw invalidCursor();
  }
  return value.map((candidate) => {
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ["id", "path"], ["marker"])
      || !safeString(candidate.id)
      || !safeString(candidate.path)
      || (
        candidate.marker !== undefined
        && !safeString(candidate.marker)
      )
    ) {
      throw invalidCursor();
    }
    return {
      id: candidate.id,
      path: candidate.path,
      ...(candidate.marker === undefined ? {} : { marker: candidate.marker }),
    };
  });
}

function projectBuffered(value: unknown): SearchCursorState["buffered"] {
  if (!Array.isArray(value) || value.length > MAX_BUFFERED_MATCHES) {
    throw invalidCursor();
  }
  return value.map((candidate) => {
    if (
      !isRecord(candidate)
      || !hasExactKeys(
        candidate,
        ["fileId", "name", "type"],
        ["size", "updatedAt", "remotePath"],
      )
      || !safeString(candidate.fileId)
      || !safeString(candidate.name)
      || (candidate.type !== "file" && candidate.type !== "folder")
      || (
        candidate.size !== undefined
        && (!Number.isSafeInteger(candidate.size) || (candidate.size as number) < 0)
      )
      || (candidate.updatedAt !== undefined && !safeString(candidate.updatedAt))
      || (candidate.remotePath !== undefined && !safeString(candidate.remotePath))
    ) {
      throw invalidCursor();
    }
    return {
      fileId: candidate.fileId,
      name: candidate.name,
      type: candidate.type,
      ...(candidate.size === undefined ? {} : { size: candidate.size as number }),
      ...(candidate.updatedAt === undefined
        ? {}
        : { updatedAt: candidate.updatedAt }),
      ...(candidate.remotePath === undefined
        ? {}
        : { remotePath: candidate.remotePath }),
    };
  });
}

function projectState(value: unknown): SearchCursorState {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["v", "identity", "pending", "buffered"])
    || value.v !== 1
  ) {
    throw invalidCursor();
  }
  return {
    v: 1,
    identity: projectIdentity(value.identity),
    pending: projectPending(value.pending),
    buffered: projectBuffered(value.buffered),
  };
}

function sameIdentity(left: SearchIdentity, right: SearchIdentity): boolean {
  return left.provider === right.provider
    && left.remoteDirectory === right.remoteDirectory
    && left.query === right.query
    && left.limit === right.limit;
}

export function encodeSearchCursor(state: SearchCursorState): string {
  try {
    const projected = projectState(state);
    const encoded = Buffer.from(JSON.stringify(projected), "utf8");
    if (encoded.byteLength > MAX_CURSOR_BYTES) {
      throw invalidCursor();
    }
    const cursor = encoded.toString("base64url");
    if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
      throw invalidCursor();
    }
    return cursor;
  } catch {
    throw invalidCursor();
  }
}

export function decodeSearchCursor(
  input: string,
  identity: SearchIdentity,
): SearchCursorState {
  try {
    if (
      typeof input !== "string"
      || Buffer.byteLength(input, "utf8") > MAX_CURSOR_BYTES
      || !BASE64URL.test(input)
      || input.length % 4 === 1
    ) {
      throw invalidCursor();
    }
    const decoded = Buffer.from(input, "base64url");
    if (
      decoded.byteLength > MAX_CURSOR_BYTES
      || decoded.toString("base64url") !== input
    ) {
      throw invalidCursor();
    }
    const projected = projectState(JSON.parse(decoded.toString("utf8")));
    const currentIdentity = projectIdentity(identity);
    if (!sameIdentity(projected.identity, currentIdentity)) {
      throw invalidCursor();
    }
    return projected;
  } catch {
    throw invalidCursor();
  }
}
