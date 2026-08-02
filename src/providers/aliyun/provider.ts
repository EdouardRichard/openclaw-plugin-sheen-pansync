import type {
  CloudDriveProvider,
  CredentialInput,
  ProviderUploadInput,
  ProviderUploadResult,
  ProviderOperationOptions,
  RemoteDirectory,
} from "../../contracts.js";
import type { CredentialRecord } from "../../credentials/types.js";
import { PanSyncError } from "../../errors.js";
import { normalizeRemoteDirectory } from "../../workspace/path-guard.js";
import { parseResourceDriveSummary } from "./resource-drive.js";
import type { AliyunFetch, AliyunTokenService } from "./types.js";
import {
  AliyunAuthorizedClient,
  type AliyunProviderUploadInput,
  type AliyunRemoteDirectory,
  type AliyunTokenRefresher,
  isAlreadyExistingName,
  uploadAliyunFile,
} from "./upload.js";

export type AliyunProviderOptions = {
  tokenService: AliyunTokenService;
  tokenManager: AliyunTokenRefresher;
  baseUrl?: string;
  fetch?: AliyunFetch;
  clock?: () => number;
};

const MAX_CREDENTIAL_FIELD_LENGTH = 4096;

type ListedFolder = {
  fileId: string;
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

function requiredCandidate(
  candidate: CredentialInput,
): CredentialInput {
  const fields = [
    candidate.authorizationPageUrl,
    candidate.refreshApiUrl,
    candidate.refreshToken,
  ];
  if (fields.some((field) =>
    typeof field !== "string"
    || field.trim().length === 0
    || field.length > MAX_CREDENTIAL_FIELD_LENGTH
  )) {
    throw new PanSyncError("CREDENTIALS_INVALID");
  }
  return candidate;
}

function maskIdentifier(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(Math.max(3, value.length));
  }
  const visiblePrefix = value.slice(0, Math.min(3, value.length - 2));
  const visibleSuffix = value.slice(-2);
  return `${visiblePrefix}***${visibleSuffix}`;
}

function maskDisplayName(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 1) {
    return "***";
  }
  return `${characters[0]}***`;
}

function parseFolder(body: unknown): ListedFolder {
  if (!isRecord(body)) {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }
  const fileId = nonEmptyString(body, "file_id");
  if (fileId === undefined) {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }
  return { fileId };
}

function listPage(body: unknown): {
  items: Array<Record<string, unknown>>;
  marker?: string;
} {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }
  const items = body.items.filter(isRecord);
  const marker =
    nonEmptyString(body, "next_marker")
    ?? nonEmptyString(body, "marker");
  return marker === undefined ? { items } : { items, marker };
}

function isAliyunRemoteDirectory(
  directory: RemoteDirectory,
): directory is AliyunRemoteDirectory {
  return (
    typeof directory.providerState === "object"
    && directory.providerState !== null
    && "driveId" in directory.providerState
    && typeof directory.providerState.driveId === "string"
    && directory.providerState.driveId.length > 0
  );
}

function isAliyunUploadInput(
  input: ProviderUploadInput,
): input is AliyunProviderUploadInput {
  return isAliyunRemoteDirectory(input.remoteDirectory);
}

export class AliyunProvider implements CloudDriveProvider {
  readonly id = "aliyun" as const;
  readonly aliases = ["阿里网盘", "阿里云盘", "aliyun", "alipan"] as const;
  readonly #clock: () => number;
  readonly #api: AliyunAuthorizedClient;

  constructor(private readonly options: AliyunProviderOptions) {
    this.#clock = options.clock ?? Date.now;
    this.#api = new AliyunAuthorizedClient({
      tokenManager: options.tokenManager,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async validateCredentials(
    candidate: CredentialInput,
    options: ProviderOperationOptions = {},
  ): Promise<CredentialRecord> {
    const completeCandidate = requiredCandidate(candidate);
    const refreshed = await this.options.tokenService.refresh({
      refreshApiUrl: completeCandidate.refreshApiUrl,
      refreshToken: completeCandidate.refreshToken,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const driveResponse = await this.#api.post(
      "/adrive/v1.0/user/getDriveInfo",
      refreshed.accessToken,
      {},
      {
        failureCode: "CREDENTIALS_INVALID",
        retryTokenFailure: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    const drive = parseResourceDriveSummary(driveResponse.body);
    const now = this.#clock();
    const account: CredentialRecord["account"] = {
      userIdMasked: maskIdentifier(drive.userId),
      ...(drive.displayName === undefined
        ? {}
        : { displayNameMasked: maskDisplayName(drive.displayName) }),
    };
    return {
      formatVersion: 2,
      credentialVersion: completeCandidate.credentialVersion ?? 1,
      authorizationPageUrl: completeCandidate.authorizationPageUrl,
      refreshApiUrl: completeCandidate.refreshApiUrl,
      refreshToken: refreshed.refreshToken,
      accessToken: refreshed.accessToken,
      account,
      lastVerifiedAt: new Date(now).toISOString(),
      refreshState: { status: "ready" },
    };
  }

  async ensureDirectory(
    remotePath: string,
    accessToken: string,
    options: ProviderOperationOptions = {},
  ): Promise<AliyunRemoteDirectory> {
    let token = accessToken;
    const driveResponse = await this.#api.post(
      "/adrive/v1.0/user/getDriveInfo",
      token,
      {},
      {
        failureCode: "CREDENTIALS_INVALID",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    token = driveResponse.accessToken;
    const drive = parseResourceDriveSummary(driveResponse.body);
    const normalizedPath = normalizeRemoteDirectory(remotePath);
    if (normalizedPath === "/") {
      return {
        id: "root",
        path: normalizedPath,
        providerState: { driveId: drive.driveId },
      };
    }

    const operationCache = new Map<string, string>();
    operationCache.set(`${drive.driveId}\0/`, "root");
    let parentId = "root";
    let currentPath = "";
    const segments = normalizedPath.slice(1).split("/");
    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`;
      const cacheKey = `${drive.driveId}\0${currentPath}`;
      const cached = operationCache.get(cacheKey);
      if (cached !== undefined) {
        parentId = cached;
        continue;
      }

      const listed = await this.#findFolder(
        drive.driveId,
        parentId,
        segment,
        token,
        options,
      );
      token = listed.accessToken;
      if (listed.fileId !== undefined) {
        parentId = listed.fileId;
        operationCache.set(cacheKey, parentId);
        continue;
      }

      const created = await this.#api.post(
        "/adrive/v1.0/openFile/create",
        token,
        {
          drive_id: drive.driveId,
          parent_file_id: parentId,
          name: segment,
          type: "folder",
          check_name_mode: "refuse",
        },
        {
          failureCode: "REMOTE_DIRECTORY_FAILED",
          allowAlreadyExisting: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      token = created.accessToken;
      if (created.alreadyExisting || isAlreadyExistingName(created.body)) {
        const raced = await this.#findFolder(
          drive.driveId,
          parentId,
          segment,
          token,
          options,
        );
        token = raced.accessToken;
        if (raced.fileId === undefined) {
          throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
        }
        parentId = raced.fileId;
      } else {
        parentId = parseFolder(created.body).fileId;
      }
      operationCache.set(cacheKey, parentId);
    }

    return {
      id: parentId,
      path: normalizedPath,
      providerState: { driveId: drive.driveId },
    };
  }

  async uploadFile(
    input: ProviderUploadInput,
    options: ProviderOperationOptions = {},
  ): Promise<ProviderUploadResult> {
    if (!isAliyunUploadInput(input)) {
      throw new PanSyncError("UPLOAD_FAILED");
    }
    return uploadAliyunFile(this.#api, input, this.#clock, options);
  }

  async #findFolder(
    driveId: string,
    parentId: string,
    name: string,
    initialAccessToken: string,
    options: ProviderOperationOptions,
  ): Promise<{ fileId?: string; accessToken: string }> {
    let marker: string | undefined;
    let accessToken = initialAccessToken;
    do {
      const listed = await this.#api.post(
        "/adrive/v1.0/openFile/list",
        accessToken,
        {
          drive_id: driveId,
          parent_file_id: parentId,
          limit: 200,
          ...(marker === undefined ? {} : { marker }),
        },
        {
          failureCode: "REMOTE_DIRECTORY_FAILED",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      accessToken = listed.accessToken;
      const page = listPage(listed.body);
      const folder = page.items.find((item) =>
        item.name === name
        && item.type === "folder"
        && typeof item.file_id === "string"
        && item.file_id.length > 0
      );
      if (folder !== undefined) {
        return {
          fileId: folder.file_id as string,
          accessToken,
        };
      }
      marker = page.marker;
    } while (marker !== undefined);

    return { accessToken };
  }
}
