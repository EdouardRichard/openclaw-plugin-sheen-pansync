import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  link,
  open,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanSyncError } from "../../src/errors.js";
import {
  isSameWorkspaceFile,
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
      expect(Object.keys(resolved).sort()).toEqual([
        "basename",
        "handle",
        "inputName",
        "size",
      ]);
      expect(resolved).toEqual({
        inputName: "report.pdf",
        basename: "report.pdf",
        size: 15,
        handle: resolved.handle,
      });
      expect(
        Object.values(resolved).filter(
          (value): value is string => typeof value === "string",
        ),
      ).not.toContain(expect.stringContaining(workspace));
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

  it("compares canonical aliases by opened-file identity without returning a pathname", async () => {
    await link(
      path.join(workspace, "report.pdf"),
      path.join(workspace, "report-alias.pdf"),
    );
    const original = await resolveWorkspaceFile(workspace, "report.pdf");
    const alias = await resolveWorkspaceFile(workspace, "report-alias.pdf");
    const different = await resolveWorkspaceFile(
      workspace,
      path.join("nested", "notes.txt"),
    );

    try {
      expect(isSameWorkspaceFile(original, alias)).toBe(true);
      expect(isSameWorkspaceFile(original, different)).toBe(false);
      expect(Object.values(original)).not.toContain(
        expect.stringContaining(workspace),
      );
      expect(Object.values(alias)).not.toContain(
        expect.stringContaining(workspace),
      );
    } finally {
      await original.handle.close();
      await alias.handle.close();
      await different.handle.close();
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

  it("rejects when an ancestor redirects the open outside the workspace", async () => {
    const nestedDirectory = path.join(workspace, "nested");
    const movedDirectory = path.join(workspace, "nested-original");
    const outsideDirectory = path.join(fixtureRoot, "outside-tree");
    const candidate = path.join(nestedDirectory, "notes.txt");
    await mkdir(outsideDirectory);
    await writeFile(
      path.join(outsideDirectory, "notes.txt"),
      "outside replacement",
    );

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        async open(target: string, flags: number) {
          if (path.resolve(target) === path.resolve(candidate)) {
            await rename(nestedDirectory, movedDirectory);
            await symlink(
              outsideDirectory,
              nestedDirectory,
              process.platform === "win32" ? "junction" : "dir",
            );
          }
          return actual.open(target, flags);
        },
      };
    });

    let resolved:
      | Awaited<ReturnType<typeof resolveWorkspaceFile>>
      | undefined;
    let rejected: unknown;
    try {
      const racedPathGuard = await import("../../src/workspace/path-guard.js");
      resolved = await racedPathGuard.resolveWorkspaceFile(
        workspace,
        path.join("nested", "notes.txt"),
      );
    } catch (error) {
      rejected = error;
    } finally {
      await resolved?.handle.close();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
  });

  it("rejects and closes a handle whose identity no longer matches its path", async () => {
    const candidate = path.join(workspace, "report.pdf");
    const movedCandidate = path.join(workspace, "report-original.pdf");
    const replacement = path.join(workspace, "report-replacement.pdf");
    await writeFile(replacement, "replacement contents");
    let openedDuringRace: FileHandle | undefined;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        async open(target: string, flags: number) {
          const handle = await actual.open(target, flags);
          if (path.resolve(target) === path.resolve(candidate)) {
            openedDuringRace = handle;
            await rename(candidate, movedCandidate);
            await rename(replacement, candidate);
          }
          return handle;
        },
      };
    });

    let resolved:
      | Awaited<ReturnType<typeof resolveWorkspaceFile>>
      | undefined;
    let rejected: unknown;
    try {
      const racedPathGuard = await import("../../src/workspace/path-guard.js");
      resolved = await racedPathGuard.resolveWorkspaceFile(
        workspace,
        "report.pdf",
      );
    } catch (error) {
      rejected = error;
    } finally {
      await resolved?.handle.close();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    expect(openedDuringRace).toBeDefined();
    await expect(openedDuringRace?.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
  });

  it("rejects a redirect between the post-open realpath and identity stat", async () => {
    const nestedDirectory = path.join(workspace, "nested");
    const movedDirectory = path.join(workspace, "nested-original");
    const outsideDirectory = path.join(fixtureRoot, "outside-interval");
    const candidate = path.join(nestedDirectory, "notes.txt");
    await mkdir(outsideDirectory);
    await writeFile(
      path.join(outsideDirectory, "notes.txt"),
      "outside interval contents",
    );
    let openedDuringRace: FileHandle | undefined;
    let redirectedForIdentityStat = false;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const linkType = process.platform === "win32" ? "junction" : "dir";
      return {
        ...actual,
        async open(target: string, flags: number) {
          if (path.resolve(target) !== path.resolve(candidate)) {
            return actual.open(target, flags);
          }

          await rename(nestedDirectory, movedDirectory);
          await symlink(outsideDirectory, nestedDirectory, linkType);
          const handle = await actual.open(target, flags);
          openedDuringRace = handle;
          await unlink(nestedDirectory);
          await rename(movedDirectory, nestedDirectory);
          return handle;
        },
        async stat(
          target: string,
          options?: Parameters<typeof actual.stat>[1],
        ) {
          if (
            path.resolve(target) === path.resolve(candidate) &&
            !redirectedForIdentityStat
          ) {
            redirectedForIdentityStat = true;
            await rename(nestedDirectory, movedDirectory);
            await symlink(outsideDirectory, nestedDirectory, linkType);
          }
          return actual.stat(target, options as never);
        },
      };
    });

    let resolved:
      | Awaited<ReturnType<typeof resolveWorkspaceFile>>
      | undefined;
    let rejected: unknown;
    try {
      const racedPathGuard = await import("../../src/workspace/path-guard.js");
      resolved = await racedPathGuard.resolveWorkspaceFile(
        workspace,
        path.join("nested", "notes.txt"),
      );
    } catch (error) {
      rejected = error;
    } finally {
      await resolved?.handle.close();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(openedDuringRace).toBeDefined();
    expect(redirectedForIdentityStat).toBe(true);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    await expect(openedDuringRace?.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
  });

  it.runIf(process.platform === "linux")(
    "rejects a FIFO without waiting for a writer",
    async () => {
      const fifoPath = path.join(workspace, "upload.fifo");
      await execFileAsync("mkfifo", [fifoPath]);
      const startedAt = Date.now();
      const rescueWriter = setTimeout(() => {
        void open(fifoPath, constants.O_WRONLY)
          .then((handle) => handle.close())
          .catch(() => undefined);
      }, 500);

      try {
        await expect(
          resolveWorkspaceFile(workspace, "upload.fifo"),
        ).rejects.toMatchObject({
          code: "WORKSPACE_PATH_REJECTED",
        });
      } finally {
        clearTimeout(rescueWriter);
      }

      expect(Date.now() - startedAt).toBeLessThan(250);
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
