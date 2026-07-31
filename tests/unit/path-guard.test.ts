import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanSyncError } from "../../src/errors.js";
import {
  normalizeRemoteDirectory,
  resolveWorkspaceFile,
} from "../../src/workspace/path-guard.js";

const execFileAsync = promisify(execFile);

let fixtureRoot: string;
let workspace: string;
let outsideFile: string;

describe("resolveWorkspaceFile", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pan-sync-path-guard-"));
    workspace = path.join(fixtureRoot, "workspace");
    outsideFile = path.join(fixtureRoot, "secret.txt");

    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await mkdir(path.join(workspace, "folder"));
    await writeFile(path.join(workspace, "report.pdf"), "report contents");
    await writeFile(
      path.join(workspace, "nested", "notes.txt"),
      "nested contents",
    );
    await writeFile(outsideFile, "outside contents");

    if (process.platform === "win32") {
      const outsideDirectory = path.join(fixtureRoot, "outside-directory");
      await mkdir(outsideDirectory);
      await symlink(
        outsideDirectory,
        path.join(workspace, "escape-link"),
        "junction",
      );
      await symlink(
        path.join(fixtureRoot, "missing-target"),
        path.join(workspace, "broken-link"),
        "junction",
      );
    } else {
      await symlink(outsideFile, path.join(workspace, "escape-link"), "file");
      await symlink(
        path.join(fixtureRoot, "missing-target"),
        path.join(workspace, "broken-link"),
        "file",
      );
    }
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("returns metadata and the already-open handle for a regular workspace file", async () => {
    const resolved = await resolveWorkspaceFile(workspace, "report.pdf");

    try {
      expect(resolved).toMatchObject({
        inputName: "report.pdf",
        basename: "report.pdf",
        size: 15,
      });
      await expect(resolved.handle.readFile("utf8")).resolves.toBe(
        "report contents",
      );
    } finally {
      await resolved.handle.close();
    }
  });

  it("accepts nested regular files", async () => {
    const resolved = await resolveWorkspaceFile(
      workspace,
      path.join("nested", "notes.txt"),
    );

    try {
      expect(resolved).toMatchObject({
        inputName: "nested/notes.txt",
        basename: "notes.txt",
        size: 15,
      });
    } finally {
      await resolved.handle.close();
    }
  });

  it("allows an absolute path inside the workspace without returning the absolute input", async () => {
    const absoluteInput = path.join(workspace, "nested", "notes.txt");
    const resolved = await resolveWorkspaceFile(workspace, absoluteInput);

    try {
      expect(resolved.inputName).toBe("nested/notes.txt");
      expect(resolved.inputName).not.toContain(workspace);
    } finally {
      await resolved.handle.close();
    }
  });

  it("rejects a lexical parent escape before treating the target as a missing file", async () => {
    await expect(
      resolveWorkspaceFile(
        workspace,
        path.join("..", "does-not-exist", "secret.txt"),
      ),
    ).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
  });

  it("rejects an absolute path outside the workspace", async () => {
    await expect(
      resolveWorkspaceFile(workspace, outsideFile),
    ).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
  });

  it("rejects a symlink that resolves outside the workspace", async () => {
    await expect(
      resolveWorkspaceFile(workspace, "escape-link"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
  });

  it("rejects a broken symlink as an unsafe workspace path", async () => {
    await expect(
      resolveWorkspaceFile(workspace, "broken-link"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
  });

  it("rejects a directory", async () => {
    await expect(resolveWorkspaceFile(workspace, "folder")).rejects.toMatchObject(
      {
        code: "WORKSPACE_PATH_REJECTED",
      },
    );
  });

  it("returns FILE_NOT_FOUND for an absent in-workspace path", async () => {
    await expect(
      resolveWorkspaceFile(workspace, "missing.txt"),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });

  it.runIf(process.platform === "linux")(
    "rejects a FIFO",
    async () => {
      const fifoPath = path.join(workspace, "upload.fifo");
      await execFileAsync("mkfifo", [fifoPath]);

      await expect(
        resolveWorkspaceFile(workspace, "upload.fifo"),
      ).rejects.toMatchObject({
        code: "WORKSPACE_PATH_REJECTED",
      });
    },
  );
});

describe("normalizeRemoteDirectory", () => {
  it.each([
    ["openClawShare/reports", "/openClawShare/reports"],
    ["/openClawShare/reports", "/openClawShare/reports"],
    ["///openClawShare//reports", "/openClawShare/reports"],
    ["openClawShare/./reports", "/openClawShare/reports"],
    ["/", "/"],
  ])("normalizes %j with POSIX semantics", (input, expected) => {
    expect(normalizeRemoteDirectory(input)).toBe(expected);
  });

  it.each([
    "/../../root",
    "openClawShare/../root",
    "/openClawShare/..",
  ])("rejects a parent segment in %j before normalization", (input) => {
    expect(() => normalizeRemoteDirectory(input)).toThrow(
      "REMOTE_DIRECTORY_FAILED",
    );
  });

  it.each([
    "/bad\u0000name",
    "/bad\u0009name",
    "/bad\u000aname",
    "/bad\u007fname",
    "/bad\u0085name",
  ])("rejects control characters in %j", (input) => {
    expect(() => normalizeRemoteDirectory(input)).toThrow(
      "REMOTE_DIRECTORY_FAILED",
    );
  });

  it("throws the stable error type for invalid input", () => {
    try {
      normalizeRemoteDirectory("/../../root");
      throw new Error("expected normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PanSyncError);
      expect((error as PanSyncError).code).toBe("REMOTE_DIRECTORY_FAILED");
    }
  });
});
