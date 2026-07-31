import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { PanSyncError } from "../errors.js";

export type ResolvedWorkspaceFile = {
  inputName: string;
  basename: string;
  size: number;
  canonicalPath: string;
  handle: FileHandle;
};

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function pathFailure(error: unknown): PanSyncError {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new PanSyncError("FILE_NOT_FOUND");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new PanSyncError("FILE_NOT_READABLE");
  }
  return new PanSyncError("WORKSPACE_PATH_REJECTED");
}

async function resolveWorkspaceRoot(workspaceDir: string): Promise<{
  lexical: string;
  canonical: string;
}> {
  const lexical = path.resolve(workspaceDir);
  try {
    const canonical = await realpath(lexical);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new PanSyncError("WORKSPACE_PATH_REJECTED");
    }
    return { lexical, canonical };
  } catch (error) {
    if (error instanceof PanSyncError) {
      throw error;
    }
    throw new PanSyncError("WORKSPACE_PATH_REJECTED");
  }
}

export async function resolveWorkspaceFile(
  workspaceDir: string,
  input: string,
): Promise<ResolvedWorkspaceFile> {
  const workspace = await resolveWorkspaceRoot(workspaceDir);
  const candidate = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(workspace.lexical, input);
  const lexicallyContained =
    isContained(workspace.lexical, candidate) ||
    (path.isAbsolute(input) && isContained(workspace.canonical, candidate));

  if (!lexicallyContained) {
    throw new PanSyncError("WORKSPACE_PATH_REJECTED");
  }

  let candidateMetadata;
  try {
    candidateMetadata = await lstat(candidate);
  } catch (error) {
    throw pathFailure(error);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
  } catch (error) {
    if (candidateMetadata.isSymbolicLink()) {
      throw new PanSyncError("WORKSPACE_PATH_REJECTED");
    }
    throw pathFailure(error);
  }

  if (!isContained(workspace.canonical, canonicalPath)) {
    throw new PanSyncError("WORKSPACE_PATH_REJECTED");
  }

  let handle: FileHandle;
  try {
    const noFollow =
      process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw pathFailure(error);
  }

  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new PanSyncError("WORKSPACE_PATH_REJECTED");
    }

    const relativeName = path.relative(workspace.canonical, canonicalPath);
    return {
      inputName: relativeName.split(path.sep).join(path.posix.sep),
      basename: path.basename(canonicalPath),
      size: openedMetadata.size,
      canonicalPath,
      handle,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof PanSyncError) {
      throw error;
    }
    throw pathFailure(error);
  }
}

const CONTROL_CHARACTER = /\p{Cc}/u;

export function normalizeRemoteDirectory(input: string): string {
  if (
    CONTROL_CHARACTER.test(input) ||
    input.split(path.posix.sep).includes("..")
  ) {
    throw new PanSyncError("REMOTE_DIRECTORY_FAILED");
  }

  const withoutLeadingSlashes = input.replace(/^\/+/, "");
  return path.posix.normalize(`/${withoutLeadingSlashes}`);
}
