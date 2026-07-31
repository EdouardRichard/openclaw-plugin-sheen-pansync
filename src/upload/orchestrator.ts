import path from "node:path";
import type {
  CloudDriveProvider,
  FileUploadResult,
  PanSyncUploadInput,
  PanSyncUploadResult,
} from "../contracts.js";
import type { PluginConfig } from "../config.js";
import type { TokenManager } from "../credentials/token-manager.js";
import { PanSyncError, safeErrorDetails } from "../errors.js";
import type { ProviderRegistry } from "../provider-registry.js";
import {
  isSameWorkspaceFile,
  normalizeRemoteDirectory,
  resolveWorkspaceFile,
  type ResolvedWorkspaceFile,
} from "../workspace/path-guard.js";

export type UploadRequest = PanSyncUploadInput & {
  workspaceDir: string;
};

export type UploadPathGuard = {
  resolveWorkspaceFile(
    workspaceDir: string,
    input: string,
  ): Promise<ResolvedWorkspaceFile>;
  isSameWorkspaceFile(
    left: ResolvedWorkspaceFile,
    right: ResolvedWorkspaceFile,
  ): boolean;
};

export type UploadOrchestratorDependencies = {
  providerRegistry: Pick<ProviderRegistry, "resolve">;
  tokenManager: Pick<TokenManager, "getValidAccessToken">;
  config: Pick<PluginConfig, "defaultDirectory">;
  pathGuard?: UploadPathGuard;
};

const defaultPathGuard: UploadPathGuard = {
  resolveWorkspaceFile,
  isSameWorkspaceFile,
};

function stableError(error: unknown): PanSyncError {
  if (error instanceof PanSyncError) {
    return error;
  }
  return new PanSyncError("UPLOAD_FAILED");
}

function safeFailedInputName(input: string): string {
  const basename = path.posix.basename(input.replaceAll("\\", "/"));
  return basename === "" || basename === "." || basename === "/"
    ? "invalid-path"
    : basename;
}

function aggregateStatus(
  files: readonly FileUploadResult[],
): PanSyncUploadResult["status"] {
  const uploaded = files.filter(({ status }) => status === "uploaded").length;
  if (uploaded === files.length) {
    return "success";
  }
  return uploaded === 0 ? "failed" : "partial";
}

export class UploadOrchestrator {
  readonly #pathGuard: UploadPathGuard;

  constructor(private readonly dependencies: UploadOrchestratorDependencies) {
    this.#pathGuard = dependencies.pathGuard ?? defaultPathGuard;
  }

  async upload(input: UploadRequest): Promise<PanSyncUploadResult> {
    if (input.paths.length < 1 || input.paths.length > 100) {
      throw new PanSyncError("UPLOAD_FAILED");
    }

    try {
      return await this.#upload(input);
    } catch (error) {
      throw stableError(error);
    }
  }

  async #upload(input: UploadRequest): Promise<PanSyncUploadResult> {
    const provider = this.dependencies.providerRegistry.resolve(input.provider);
    const remoteDirectory = normalizeRemoteDirectory(
      input.remoteDirectory ?? this.dependencies.config.defaultDirectory,
    );
    const accessToken =
      await this.dependencies.tokenManager.getValidAccessToken();
    const directory = await provider.ensureDirectory(
      remoteDirectory,
      accessToken,
    );

    const distinctFiles: ResolvedWorkspaceFile[] = [];
    const files: FileUploadResult[] = [];
    for (const requestedPath of input.paths) {
      let file: ResolvedWorkspaceFile;
      try {
        file = await this.#pathGuard.resolveWorkspaceFile(
          input.workspaceDir,
          requestedPath,
        );
      } catch (error) {
        files.push({
          inputName: safeFailedInputName(requestedPath),
          status: "failed",
          errorCode: safeErrorDetails(error).code,
        });
        continue;
      }

      try {
        if (
          distinctFiles.some((candidate) =>
            this.#pathGuard.isSameWorkspaceFile(candidate, file)
          )
        ) {
          continue;
        }
        distinctFiles.push(file);
        files.push(
          await this.#uploadFile(provider, accessToken, directory, file),
        );
      } catch (error) {
        files.push({
          inputName: file.inputName,
          status: "failed",
          errorCode: safeErrorDetails(error).code,
        });
      } finally {
        await file.handle.close().catch(() => undefined);
      }
    }

    return {
      provider: provider.id,
      remoteDirectory,
      status: aggregateStatus(files),
      files,
    };
  }

  async #uploadFile(
    provider: CloudDriveProvider,
    accessToken: string,
    remoteDirectory: Awaited<
      ReturnType<CloudDriveProvider["ensureDirectory"]>
    >,
    file: ResolvedWorkspaceFile,
  ): Promise<FileUploadResult> {
    const uploaded = await provider.uploadFile({
      accessToken,
      file,
      remoteDirectory,
    });
    return {
      inputName: file.inputName,
      remoteName: uploaded.remoteName,
      size: uploaded.size,
      status: "uploaded",
    };
  }
}
