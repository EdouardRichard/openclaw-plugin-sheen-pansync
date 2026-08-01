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
  uploadFile(input: ProviderUploadInput, options?: ProviderOperationOptions): Promise<ProviderUploadResult>;
}
