import type { PanSyncErrorCode } from "./errors.js";
import type { CredentialRecord } from "./credentials/types.js";
import type { ResolvedWorkspaceFile } from "./workspace/path-guard.js";

export type ProviderId = "aliyun";

export type PanSyncUploadInput = {
  paths: string[];
  provider?: ProviderId;
  remoteDirectory?: string;
};

export type FileUploadResult = {
  inputName: string;
  remoteName?: string;
  size?: number;
  status: "uploaded" | "failed";
  errorCode?: PanSyncErrorCode;
};

export type PanSyncUploadResult = {
  provider: ProviderId;
  remoteDirectory: string;
  status: "success" | "partial" | "failed";
  files: FileUploadResult[];
};

export type PanSyncListInput = {
  provider?: ProviderId;
  remoteDirectory?: string;
  query?: string;
  limit?: number;
  cursor?: string;
};

export type PanSyncListResult = {
  provider: ProviderId;
  remoteDirectory: string;
  query?: string;
  entries: Array<{
    fileId: string;
    name: string;
    type: "file" | "folder";
    size?: number;
    updatedAt?: string;
    remotePath?: string;
  }>;
  nextCursor?: string;
};

export type PanSyncDownloadInput = {
  provider?: ProviderId;
  fileId?: string;
  remotePath?: string;
  localDirectory?: string;
  confirmedLargeDownload?: boolean;
};

export type PanSyncDownloadResult =
  | {
      provider: ProviderId;
      remoteName: string;
      localPath: string;
      size: number;
      status: "downloaded";
    }
  | {
      provider: ProviderId;
      remoteName: string;
      fileId: string;
      size: number;
      status: "confirmation_required";
      code: "DOWNLOAD_CONFIRMATION_REQUIRED";
    };

export type CredentialInput = {
  authorizationPageUrl: string;
  refreshApiUrl: string;
  refreshToken: string;
  credentialVersion?: number;
};

export type ValidatedCredentialRecord = CredentialRecord;

export type RemoteDirectory = {
  id: string;
  path: string;
  providerState: Readonly<Record<string, unknown>>;
};

export type RemoteEntry = {
  id: string;
  parentId: string;
  name: string;
  type: "file" | "folder";
  size?: number;
  updatedAt?: string;
  remotePath?: string;
  providerState: Readonly<Record<string, unknown>>;
};

export type RemoteEntryPage = {
  entries: RemoteEntry[];
  nextMarker?: string;
};

export type ProviderListInput = {
  accessToken: string;
  directory: RemoteDirectory;
  marker?: string;
  limit: number;
};

export type ProviderDownloadInput = {
  accessToken: string;
  entry: RemoteEntry;
};

export type ProviderDownload = {
  stream: ReadableStream<Uint8Array>;
  size: number;
};

export type ProviderUploadInput = {
  accessToken: string;
  file: ResolvedWorkspaceFile;
  remoteDirectory: RemoteDirectory;
  remoteName?: string;
};

export type ProviderUploadResult = {
  remoteName: string;
  size: number;
};

export type ProviderOperationOptions = {
  signal?: AbortSignal;
};

export interface CloudDriveProvider {
  readonly id: ProviderId;
  readonly aliases: readonly string[];
  validateCredentials(candidate: CredentialInput, options?: ProviderOperationOptions): Promise<ValidatedCredentialRecord>;
  ensureDirectory(remotePath: string, accessToken: string, options?: ProviderOperationOptions): Promise<RemoteDirectory>;
  getReadRoot(accessToken: string, options?: ProviderOperationOptions): Promise<RemoteDirectory>;
  resolveEntry(remotePath: string, accessToken: string, options?: ProviderOperationOptions): Promise<RemoteEntry>;
  getEntryById(fileId: string, accessToken: string, options?: ProviderOperationOptions): Promise<RemoteEntry>;
  listEntries(input: ProviderListInput, options?: ProviderOperationOptions): Promise<RemoteEntryPage>;
  openDownload(input: ProviderDownloadInput, options?: ProviderOperationOptions): Promise<ProviderDownload>;
  uploadFile(input: ProviderUploadInput, options?: ProviderOperationOptions): Promise<ProviderUploadResult>;
}
