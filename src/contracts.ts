import type { PanSyncErrorCode } from "./errors.js";

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
  refreshToken: string;
};

export type ValidatedCredentialRecord = {
  accessToken: string;
  refreshToken: string;
};

export type RemoteDirectory = {
  id: string;
  path: string;
};

export type ProviderUploadInput = {
  accessToken: string;
  localPath: string;
  remoteDirectory: RemoteDirectory;
  remoteName?: string;
};

export type ProviderUploadResult = {
  remoteName: string;
  size: number;
};

export interface CloudDriveProvider {
  readonly id: ProviderId;
  readonly aliases: readonly string[];
  validateCredentials(candidate: CredentialInput): Promise<ValidatedCredentialRecord>;
  ensureDirectory(remotePath: string, accessToken: string): Promise<RemoteDirectory>;
  uploadFile(input: ProviderUploadInput): Promise<ProviderUploadResult>;
}
