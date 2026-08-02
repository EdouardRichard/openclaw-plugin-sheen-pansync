import path from "node:path";
import type {
  CloudDriveProvider,
  PanSyncDownloadInput,
  PanSyncDownloadResult,
  PanSyncListInput,
  PanSyncListResult,
  ProviderOperationOptions,
  RemoteDirectory,
  RemoteEntry,
} from "../contracts.js";
import type { TokenManager } from "../credentials/token-manager.js";
import { PanSyncError } from "../errors.js";
import type { ProviderRegistry } from "../provider-registry.js";
import {
  openWorkspaceDownloadTarget,
  type WorkspaceDownloadTarget,
} from "../workspace/download-target.js";
import { normalizeRemoteDirectory } from "../workspace/path-guard.js";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchCursorState,
  type SearchIdentity,
} from "./cursor.js";

const DEFAULT_LIMIT = 20;
const SEARCH_PAGE_LIMIT = 100;
const MAX_SEARCH_PAGES = 20;
const MAX_PENDING_DIRECTORIES = 512;
const MAX_BUFFERED_MATCHES = 100;
const CONTROL_CHARACTER = /\p{Cc}/u;
const LARGE_DOWNLOAD_THRESHOLD = 100 * 1024 * 1024;

export type DownloadRequest = PanSyncDownloadInput & { workspaceDir: string };

export type ReadOrchestratorDependencies = {
  providerRegistry: Pick<ProviderRegistry, "resolve">;
  tokenManager: Pick<TokenManager, "getValidAccessToken">;
};

function stableReadError(error: unknown): PanSyncError {
  return error instanceof PanSyncError
    ? error
    : new PanSyncError("REMOTE_DIRECTORY_FAILED");
}

function stableDownloadError(error: unknown): PanSyncError {
  return error instanceof PanSyncError
    ? error
    : new PanSyncError("DOWNLOAD_FAILED");
}

function assertDownloadActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PanSyncError("DOWNLOAD_FAILED");
  }
}

async function writeChunk(
  target: WorkspaceDownloadTarget,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await target.handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new PanSyncError("DOWNLOAD_FAILED");
    }
    offset += bytesWritten;
  }
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100;
}

function projectRemoteEntry(entry: RemoteEntry): PanSyncListResult["entries"][number] {
  return {
    fileId: entry.id,
    name: entry.name,
    type: entry.type,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
    ...(entry.remotePath === undefined ? {} : { remotePath: entry.remotePath }),
  };
}

function matchKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isWithinRoot(remoteDirectory: string, candidate: string): boolean {
  if (normalizeRemoteDirectory(candidate) !== candidate) {
    return false;
  }
  if (remoteDirectory === "/") {
    return candidate.startsWith("/");
  }
  return candidate === remoteDirectory
    || candidate.startsWith(
      remoteDirectory.endsWith("/") ? remoteDirectory : `${remoteDirectory}/`,
    );
}

function assertSearchState(
  state: SearchCursorState,
  remoteDirectory: string,
): void {
  if (
    state.pending.length > MAX_PENDING_DIRECTORIES
    || state.buffered.length > MAX_BUFFERED_MATCHES
    || state.pending.some(({ path: pendingPath }) =>
      !isWithinRoot(remoteDirectory, pendingPath))
  ) {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }
}

async function resolveDirectory(
  provider: CloudDriveProvider,
  remoteDirectory: string,
  accessToken: string,
  options: ProviderOperationOptions,
): Promise<RemoteDirectory> {
  if (remoteDirectory === "/") {
    return provider.getReadRoot(accessToken, options);
  }
  const entry = await provider.resolveEntry(remoteDirectory, accessToken, options);
  if (entry.type !== "folder") {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }
  return {
    id: entry.id,
    path: remoteDirectory,
    providerState: entry.providerState,
  };
}

export class ReadOrchestrator {
  constructor(private readonly dependencies: ReadOrchestratorDependencies) {}

  async download(
    input: DownloadRequest,
    options: ProviderOperationOptions = {},
  ): Promise<PanSyncDownloadResult> {
    if ((input.fileId === undefined) === (input.remotePath === undefined)) {
      throw new PanSyncError("REMOTE_FILE_AMBIGUOUS");
    }

    const provider = this.dependencies.providerRegistry.resolve(input.provider);
    const accessToken = await this.dependencies.tokenManager.getValidAccessToken(options);
    let entry: RemoteEntry;
    try {
      entry = input.fileId === undefined
        ? await provider.resolveEntry(input.remotePath!, accessToken, options)
        : await provider.getEntryById(input.fileId, accessToken, options);
    } catch (error) {
      throw stableDownloadError(error);
    }

    if (entry.type !== "file") {
      throw new PanSyncError("REMOTE_ENTRY_NOT_FILE");
    }
    if (
      entry.size === undefined
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
    ) {
      throw new PanSyncError("DOWNLOAD_FAILED");
    }
    if (
      entry.size > LARGE_DOWNLOAD_THRESHOLD
      && !input.confirmedLargeDownload
    ) {
      return {
        provider: provider.id,
        remoteName: entry.name,
        fileId: entry.id,
        size: entry.size,
        status: "confirmation_required",
        code: "DOWNLOAD_CONFIRMATION_REQUIRED",
      };
    }

    let target: WorkspaceDownloadTarget | undefined;
    try {
      target = await openWorkspaceDownloadTarget(
        input.workspaceDir,
        input.localDirectory,
        entry.name,
      );
      assertDownloadActive(options.signal);
      const download = await provider.openDownload({
        accessToken,
        entry,
      }, options);
      if (download.size !== entry.size) {
        throw new PanSyncError("DOWNLOAD_FAILED");
      }

      let written = 0;
      for await (const chunk of download.stream) {
        assertDownloadActive(options.signal);
        if (!(chunk instanceof Uint8Array)) {
          throw new PanSyncError("DOWNLOAD_FAILED");
        }
        if (written + chunk.byteLength > entry.size) {
          throw new PanSyncError("DOWNLOAD_FAILED");
        }
        await writeChunk(target, chunk);
        written += chunk.byteLength;
      }
      assertDownloadActive(options.signal);
      if (written !== entry.size) {
        throw new PanSyncError("DOWNLOAD_FAILED");
      }
      await target.handle.close();
      return {
        provider: provider.id,
        remoteName: entry.name,
        localPath: target.relativePath,
        size: written,
        status: "downloaded",
      };
    } catch (error) {
      try {
        await target?.cleanup();
      } catch {
        // Cleanup errors are intentionally collapsed into the stable download error.
      }
      throw stableDownloadError(error);
    }
  }

  async list(
    input: PanSyncListInput,
    options: ProviderOperationOptions = {},
  ): Promise<PanSyncListResult> {
    try {
      return await this.#list(input, options);
    } catch (error) {
      throw stableReadError(error);
    }
  }

  async #list(
    input: PanSyncListInput,
    options: ProviderOperationOptions,
  ): Promise<PanSyncListResult> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!validLimit(limit)) {
      throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
    }
    const remoteDirectory = normalizeRemoteDirectory(input.remoteDirectory ?? "/");
    const provider = this.dependencies.providerRegistry.resolve(input.provider);
    if (
      input.query !== undefined
      && (input.query.length === 0 || CONTROL_CHARACTER.test(input.query))
    ) {
      throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
    }
    if (input.query !== undefined) {
      return this.#search(
        provider,
        remoteDirectory,
        input.query,
        limit,
        input.cursor,
        options,
      );
    }
    return this.#listDirectory(
      provider,
      remoteDirectory,
      limit,
      input.cursor,
      options,
    );
  }

  async #listDirectory(
    provider: CloudDriveProvider,
    remoteDirectory: string,
    limit: number,
    inputCursor: string | undefined,
    options: ProviderOperationOptions,
  ): Promise<PanSyncListResult> {
    const identity: SearchIdentity = {
      provider: provider.id,
      remoteDirectory,
      query: "",
      limit,
    };
    const cursor = inputCursor === undefined
      ? undefined
      : decodeSearchCursor(inputCursor, identity);
    if (
      cursor !== undefined
      && (
        cursor.pending.length !== 1
        || cursor.buffered.length !== 0
        || cursor.pending[0]?.path !== remoteDirectory
      )
    ) {
      throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
    }
    const accessToken = await this.dependencies.tokenManager.getValidAccessToken(options);
    const directory = await resolveDirectory(
      provider,
      remoteDirectory,
      accessToken,
      options,
    );
    if (cursor !== undefined && cursor.pending[0]?.id !== directory.id) {
      throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
    }
    const marker = cursor?.pending[0]?.marker;
    const page = await provider.listEntries({
      accessToken,
      directory,
      ...(marker === undefined ? {} : { marker }),
      limit,
    }, options);
    const nextCursor = page.nextMarker === undefined
      ? undefined
      : encodeSearchCursor({
        v: 1,
        identity,
        pending: [{ id: directory.id, path: remoteDirectory, marker: page.nextMarker }],
        buffered: [],
      });
    return {
      provider: provider.id,
      remoteDirectory,
      entries: page.entries.map(projectRemoteEntry),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async #search(
    provider: CloudDriveProvider,
    remoteDirectory: string,
    query: string,
    limit: number,
    inputCursor: string | undefined,
    options: ProviderOperationOptions,
  ): Promise<PanSyncListResult> {
    const identity: SearchIdentity = {
      provider: provider.id,
      remoteDirectory,
      query,
      limit,
    };
    const resumed = inputCursor === undefined
      ? undefined
      : decodeSearchCursor(inputCursor, identity);
    if (resumed !== undefined) {
      assertSearchState(resumed, remoteDirectory);
    }
    let state = resumed;
    const entries = state?.buffered.splice(0, limit) ?? [];
    if (
      state !== undefined
      && (entries.length === limit || state.pending.length === 0)
    ) {
      const nextCursor = state.pending.length === 0 && state.buffered.length === 0
        ? undefined
        : encodeSearchCursor(state);
      return {
        provider: provider.id,
        remoteDirectory,
        query,
        entries,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    }
    const accessToken = await this.dependencies.tokenManager.getValidAccessToken(options);
    const root = await resolveDirectory(
      provider,
      remoteDirectory,
      accessToken,
      options,
    );
    state ??= {
      v: 1,
      identity,
      pending: [{ id: root.id, path: remoteDirectory }],
      buffered: [],
    };
    const queryKey = matchKey(query);
    let providerPages = 0;

    while (
      entries.length < limit
      && state.pending.length > 0
      && providerPages < MAX_SEARCH_PAGES
    ) {
      const current = state.pending[0];
      if (current === undefined) {
        break;
      }
      const page = await provider.listEntries({
        accessToken,
        directory: {
          id: current.id,
          path: current.path,
          providerState: root.providerState,
        },
        ...(current.marker === undefined ? {} : { marker: current.marker }),
        limit: SEARCH_PAGE_LIMIT,
      }, options);
      providerPages += 1;

      const discovered: SearchCursorState["pending"] = [];
      for (const remoteEntry of page.entries) {
        if (remoteEntry.type === "folder") {
          const entryPath = normalizeRemoteDirectory(
            remoteEntry.remotePath
              ?? path.posix.join(current.path, remoteEntry.name),
          );
          if (!isWithinRoot(remoteDirectory, entryPath)) {
            throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
          }
          discovered.push({ id: remoteEntry.id, path: entryPath });
        }
        if (matchKey(remoteEntry.name).includes(queryKey)) {
          const projected = projectRemoteEntry(remoteEntry);
          if (entries.length < limit) {
            entries.push(projected);
          } else {
            state.buffered.push(projected);
            if (state.buffered.length > MAX_BUFFERED_MATCHES) {
              throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
            }
          }
        }
      }

      if (page.nextMarker === undefined) {
        state.pending.shift();
      } else {
        state.pending[0] = {
          id: current.id,
          path: current.path,
          marker: page.nextMarker,
        };
      }
      state.pending.push(...discovered);
      if (state.pending.length > MAX_PENDING_DIRECTORIES) {
        throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
      }
    }

    const nextCursor = state.pending.length === 0 && state.buffered.length === 0
      ? undefined
      : encodeSearchCursor(state);
    return {
      provider: provider.id,
      remoteDirectory,
      query,
      entries,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
}
