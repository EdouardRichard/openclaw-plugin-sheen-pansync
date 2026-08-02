import type { RemoteEntry, RemoteEntryPage } from "../../contracts.js";
import { PanSyncError, type PanSyncErrorCode } from "../../errors.js";
import { normalizeRemoteDirectory } from "../../workspace/path-guard.js";

type EntryParseOptions = {
  driveId: string;
  failureCode: PanSyncErrorCode;
  parentPath?: string;
  remotePath?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  failureCode: PanSyncErrorCode,
): string {
  const value = nonEmptyString(record, key);
  if (value === undefined) throw new PanSyncError(failureCode);
  return value;
}

function safeEntryName(
  record: Record<string, unknown>,
  failureCode: PanSyncErrorCode,
): string {
  const name = requiredString(record, "name", failureCode);
  if (
    name === "."
    || name === ".."
    || /[\\/\p{Cc}]/u.test(name)
  ) {
    throw new PanSyncError(failureCode);
  }
  return name;
}

function optionalSize(
  record: Record<string, unknown>,
  failureCode: PanSyncErrorCode,
): number | undefined {
  const value = record.size;
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new PanSyncError(failureCode);
  }
  return value;
}

function optionalUpdatedAt(
  record: Record<string, unknown>,
  failureCode: PanSyncErrorCode,
): string | undefined {
  const value = record.updated_at;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new PanSyncError(failureCode);
  }
  return value;
}

function childPath(parentPath: string, name: string): string {
  const normalizedParent = normalizeRemoteDirectory(parentPath);
  return normalizedParent === "/"
    ? `/${name}`
    : `${normalizedParent}/${name}`;
}

export function parseAliyunRemoteEntry(
  body: unknown,
  options: EntryParseOptions,
): RemoteEntry {
  if (!isRecord(body)) throw new PanSyncError(options.failureCode);
  const type = body.type;
  if (type !== "file" && type !== "folder") {
    throw new PanSyncError(options.failureCode);
  }
  const id = requiredString(body, "file_id", options.failureCode);
  const parentId = requiredString(body, "parent_file_id", options.failureCode);
  const name = safeEntryName(body, options.failureCode);
  const size = optionalSize(body, options.failureCode);
  const updatedAt = optionalUpdatedAt(body, options.failureCode);
  const remotePath = options.remotePath ?? (
    options.parentPath === undefined
      ? undefined
      : childPath(options.parentPath, name)
  );

  return {
    id,
    parentId,
    name,
    type,
    ...(size === undefined ? {} : { size }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(remotePath === undefined ? {} : { remotePath }),
    providerState: { driveId: options.driveId },
  };
}

export function parseAliyunRemoteEntryPage(
  body: unknown,
  driveId: string,
  parentPath: string,
): RemoteEntryPage {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }
  const marker = body.next_marker ?? body.marker;
  if (
    marker !== undefined
    && typeof marker !== "string"
  ) {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }
  const entries = body.items.map((item) => parseAliyunRemoteEntry(item, {
    driveId,
    parentPath,
    failureCode: "REMOTE_DIRECTORY_FAILED",
  }));
  return marker === undefined || marker === ""
    ? { entries }
    : { entries, nextMarker: marker };
}

export function parseAliyunDownloadUrl(body: unknown): string {
  if (!isRecord(body)) throw new PanSyncError("DOWNLOAD_FAILED");
  const value = nonEmptyString(body, "url");
  if (value === undefined) throw new PanSyncError("DOWNLOAD_FAILED");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new PanSyncError("DOWNLOAD_FAILED");
    }
  } catch {
    throw new PanSyncError("DOWNLOAD_FAILED");
  }
  return value;
}
