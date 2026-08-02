import {
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { PanSyncError } from "../errors.js";

export type WorkspaceDownloadTarget = {
  handle: FileHandle;
  relativePath: string;
  cleanup(): Promise<void>;
};

const CONTROL_CHARACTER = /\p{Cc}/u;
const WINDOWS_INVALID_FILENAME_CHARACTER = /[<>:"/\\|?*]/u;
const WINDOWS_RESERVED_DEVICE_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function rejectWorkspacePath(): PanSyncError {
  return new PanSyncError("WORKSPACE_PATH_REJECTED");
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/u).includes("..");
}

function safeRemoteBasename(remoteName: string): string {
  if (
    remoteName.length === 0
    || CONTROL_CHARACTER.test(remoteName)
    || WINDOWS_INVALID_FILENAME_CHARACTER.test(remoteName)
    || /[. ]$/u.test(remoteName)
    || WINDOWS_RESERVED_DEVICE_BASENAME.test(remoteName)
  ) {
    throw rejectWorkspacePath();
  }
  if (remoteName === "." || remoteName === "..") {
    throw rejectWorkspacePath();
  }
  return remoteName;
}

async function resolveWorkspaceRoot(workspaceDir: string): Promise<{
  lexical: string;
  canonical: string;
}> {
  const lexical = path.resolve(workspaceDir);
  try {
    const canonical = await realpath(lexical);
    if (!(await stat(canonical)).isDirectory()) {
      throw rejectWorkspacePath();
    }
    return { lexical, canonical };
  } catch (error) {
    if (error instanceof PanSyncError) {
      throw error;
    }
    throw rejectWorkspacePath();
  }
}

async function resolveTargetDirectory(
  workspace: { lexical: string; canonical: string },
  localDirectory: string | undefined,
): Promise<string> {
  if (localDirectory === undefined) {
    return workspace.canonical;
  }
  if (
    localDirectory.length === 0
    || CONTROL_CHARACTER.test(localDirectory)
    || path.isAbsolute(localDirectory)
    || path.win32.isAbsolute(localDirectory)
    || path.posix.isAbsolute(localDirectory)
    || hasParentSegment(localDirectory)
  ) {
    throw rejectWorkspacePath();
  }

  const lexicalDirectory = path.resolve(workspace.lexical, localDirectory);
  if (!isContained(workspace.lexical, lexicalDirectory)) {
    throw rejectWorkspacePath();
  }
  try {
    const canonicalDirectory = await realpath(lexicalDirectory);
    if (
      !isContained(workspace.canonical, canonicalDirectory)
      || !(await stat(canonicalDirectory)).isDirectory()
    ) {
      throw rejectWorkspacePath();
    }
    return canonicalDirectory;
  } catch (error) {
    if (error instanceof PanSyncError) {
      throw error;
    }
    throw rejectWorkspacePath();
  }
}

export async function openWorkspaceDownloadTarget(
  workspaceDir: string,
  localDirectory: string | undefined,
  remoteName: string,
): Promise<WorkspaceDownloadTarget> {
  const workspace = await resolveWorkspaceRoot(workspaceDir);
  const targetDirectory = await resolveTargetDirectory(workspace, localDirectory);
  const safeName = safeRemoteBasename(remoteName);
  const parsedName = path.parse(safeName);

  for (let collision = 0; ; collision += 1) {
    const candidateName = collision === 0
      ? safeName
      : `${parsedName.name} (${collision})${parsedName.ext}`;
    const candidate = path.join(targetDirectory, candidateName);
    let handle: FileHandle;
    try {
      handle = await open(candidate, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        continue;
      }
      throw rejectWorkspacePath();
    }

    let closed = false;
    let removed = false;
    return {
      handle,
      relativePath: path.relative(workspace.canonical, candidate).split(path.sep).join("/"),
      async cleanup(): Promise<void> {
        if (removed) {
          return;
        }
        if (!closed) {
          try {
            await handle.close();
            closed = true;
          } catch (error) {
            if (errorCode(error) !== "EBADF") {
              throw rejectWorkspacePath();
            }
            closed = true;
          }
        }
        try {
          await unlink(candidate);
          removed = true;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            throw rejectWorkspacePath();
          }
          removed = true;
        }
      },
    };
  }
}
