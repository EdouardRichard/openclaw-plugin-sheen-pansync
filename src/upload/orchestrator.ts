import path from "node:path";
import type {
  CloudDriveProvider,
  FileUploadResult,
  PanSyncUploadInput,
  PanSyncUploadResult,
  ProviderOperationOptions,
} from "../contracts.js";
import type { PluginConfig } from "../config.js";
import type { TokenManager } from "../credentials/token-manager.js";
import {
  PanSyncError,
  safeErrorDetails,
  type PanSyncErrorCode,
} from "../errors.js";
import type { ProviderRegistry } from "../provider-registry.js";
import {
  isSameWorkspaceFile,
  normalizeRemoteDirectory,
  resolveWorkspaceFile,
  type ResolvedWorkspaceFile,
} from "../workspace/path-guard.js";
import { FifoUploadGate } from "./upload-concurrency.js";

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

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PanSyncError("UPLOAD_FAILED");
  }
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/u;

function safeFailedInputName(input: string): string {
  const normalizedSeparators = input.replaceAll("\\", "/");
  const segments = normalizedSeparators.split("/");
  const basename = path.posix.basename(normalizedSeparators);
  if (
    input.trim().length === 0
    || CONTROL_CHARACTER.test(input)
    || path.posix.isAbsolute(normalizedSeparators)
    || WINDOWS_DRIVE_PATH.test(normalizedSeparators)
    || segments.some((segment) => segment === "." || segment === "..")
    || basename.trim().length === 0
    || basename === "."
    || basename === ".."
  ) {
    return "invalid-path";
  }
  return basename;
}

const GLOBAL_UPLOAD_ERROR_CODES: ReadonlySet<PanSyncErrorCode> = new Set([
  "CREDENTIALS_REQUIRED",
  "CREDENTIALS_INVALID",
  "REFRESH_TOKEN_REJECTED",
  "AUTHORIZATION_REVOKED",
  "TOKEN_ENDPOINT_UNAVAILABLE",
  "RATE_LIMITED",
]);

function isGlobalUploadError(error: unknown): error is PanSyncError {
  return (
    error instanceof PanSyncError
    && GLOBAL_UPLOAD_ERROR_CODES.has(error.code)
  );
}

type PreparedUpload = {
  kind: "upload";
  file: ResolvedWorkspaceFile;
};

type PreparedFailure = {
  kind: "failure";
  result: FileUploadResult;
};

type PreparedEntry = PreparedUpload | PreparedFailure;

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
  readonly #uploadGate = new FifoUploadGate();

  constructor(private readonly dependencies: UploadOrchestratorDependencies) {
    this.#pathGuard = dependencies.pathGuard ?? defaultPathGuard;
  }

  async upload(
    input: UploadRequest,
    options: ProviderOperationOptions = {},
  ): Promise<PanSyncUploadResult> {
    if (input.paths.length < 1 || input.paths.length > 100) {
      throw new PanSyncError("UPLOAD_FAILED");
    }

    let releaseUpload: (() => void) | undefined;
    try {
      releaseUpload = await this.#uploadGate.acquire(options.signal);
      return await this.#upload(input, options);
    } catch (error) {
      throw stableError(error);
    } finally {
      releaseUpload?.();
    }
  }

  async #upload(
    input: UploadRequest,
    options: ProviderOperationOptions,
  ): Promise<PanSyncUploadResult> {
    assertActive(options.signal);
    const provider = this.dependencies.providerRegistry.resolve(input.provider);
    const remoteDirectory = normalizeRemoteDirectory(
      input.remoteDirectory ?? this.dependencies.config.defaultDirectory,
    );
    const accessToken =
      await this.dependencies.tokenManager.getValidAccessToken(options);
    assertActive(options.signal);
    const directory = await provider.ensureDirectory(
      remoteDirectory,
      accessToken,
      options,
    );
    assertActive(options.signal);

    const distinctFiles: ResolvedWorkspaceFile[] = [];
    try {
      const prepared = await this.#prepareFiles(input, distinctFiles, options);
      const files: FileUploadResult[] = [];
      for (const entry of prepared) {
        if (entry.kind === "failure") {
          files.push(entry.result);
          continue;
        }

        try {
          assertActive(options.signal);
          files.push(
            await this.#uploadFile(
              provider,
              accessToken,
              directory,
              entry.file,
              options,
            ),
          );
        } catch (error) {
          if (options.signal?.aborted === true) {
            throw stableError(error);
          }
          if (isGlobalUploadError(error)) {
            throw error;
          }
          files.push({
            inputName: entry.file.inputName,
            status: "failed",
            errorCode: safeErrorDetails(error).code,
          });
        }
      }

      return {
        provider: provider.id,
        remoteDirectory,
        status: aggregateStatus(files),
        files,
      };
    } finally {
      await this.#closeFiles(distinctFiles);
    }
  }

  async #prepareFiles(
    input: UploadRequest,
    distinctFiles: ResolvedWorkspaceFile[],
    options: ProviderOperationOptions,
  ): Promise<PreparedEntry[]> {
    const prepared: PreparedEntry[] = [];
    for (const requestedPath of input.paths) {
      assertActive(options.signal);
      let file: ResolvedWorkspaceFile;
      try {
        file = await this.#pathGuard.resolveWorkspaceFile(
          input.workspaceDir,
          requestedPath,
        );
      } catch (error) {
        prepared.push({
          kind: "failure",
          result: {
            inputName: safeFailedInputName(requestedPath),
            status: "failed",
            errorCode: safeErrorDetails(error).code,
          },
        });
        continue;
      }

      try {
        if (
          distinctFiles.some((candidate) =>
            this.#pathGuard.isSameWorkspaceFile(candidate, file)
          )
        ) {
          await file.handle.close().catch(() => undefined);
          continue;
        }
      } catch (error) {
        await file.handle.close().catch(() => undefined);
        prepared.push({
          kind: "failure",
          result: {
            inputName: file.inputName,
            status: "failed",
            errorCode: safeErrorDetails(error).code,
          },
        });
        continue;
      }

      distinctFiles.push(file);
      prepared.push({ kind: "upload", file });
    }
    return prepared;
  }

  async #closeFiles(files: readonly ResolvedWorkspaceFile[]): Promise<void> {
    for (const file of files) {
      await file.handle.close().catch(() => undefined);
    }
  }

  async #uploadFile(
    provider: CloudDriveProvider,
    accessToken: string,
    remoteDirectory: Awaited<
      ReturnType<CloudDriveProvider["ensureDirectory"]>
    >,
    file: ResolvedWorkspaceFile,
    options: ProviderOperationOptions,
  ): Promise<FileUploadResult> {
    const uploaded = await provider.uploadFile(
      { accessToken, file, remoteDirectory },
      options,
    );
    return {
      inputName: file.inputName,
      remoteName: uploaded.remoteName,
      size: uploaded.size,
      status: "uploaded",
    };
  }
}
