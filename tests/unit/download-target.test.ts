import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openWorkspaceDownloadTarget } from "../../src/workspace/download-target.js";

const fsMocks = vi.hoisted(() => ({
  open: vi.fn(),
  actualOpen: undefined as unknown as typeof import("node:fs/promises").open,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.actualOpen = actual.open;
  return { ...actual, open: fsMocks.open };
});

let fixtureRoot: string;
let workspace: string;
let outside: string;

describe("openWorkspaceDownloadTarget", () => {
  beforeEach(async () => {
    fsMocks.open.mockImplementation((...args) =>
      Reflect.apply(fsMocks.actualOpen, undefined, args));
    fsMocks.open.mockClear();
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pan-sync-download-target-"));
    workspace = path.join(fixtureRoot, "workspace");
    outside = path.join(fixtureRoot, "outside");
    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("uses extension-aware collision names without overwriting the first file", async () => {
    const first = await openWorkspaceDownloadTarget(
      workspace,
      undefined,
      "report.pdf",
    );
    await first.handle.writeFile("first");
    await first.handle.close();

    const second = await openWorkspaceDownloadTarget(
      workspace,
      undefined,
      "report.pdf",
    );
    try {
      expect(first.relativePath).toBe("report.pdf");
      expect(second.relativePath).toBe("report (1).pdf");
      expect(await readFile(path.join(workspace, "report.pdf"), "utf8")).toBe(
        "first",
      );
    } finally {
      await second.cleanup();
      await first.cleanup();
    }
  });

  it("creates unique files for concurrent calls", async () => {
    const targets = await Promise.all(
      Array.from({ length: 6 }, () =>
        openWorkspaceDownloadTarget(workspace, undefined, "report.tar.gz")),
    );

    try {
      expect(targets.map(({ relativePath }) => relativePath).sort()).toEqual([
        "report.tar (1).gz",
        "report.tar (2).gz",
        "report.tar (3).gz",
        "report.tar (4).gz",
        "report.tar (5).gz",
        "report.tar.gz",
      ]);
    } finally {
      await Promise.all(targets.map((target) => target.cleanup()));
    }
  });

  it("creates the file in an existing nested workspace directory", async () => {
    const target = await openWorkspaceDownloadTarget(
      workspace,
      "nested",
      "notes.txt",
    );

    try {
      await target.handle.writeFile("nested contents");
      expect(target.relativePath).toBe("nested/notes.txt");
      expect(
        await readFile(path.join(workspace, "nested", "notes.txt"), "utf8"),
      ).toBe("nested contents");
    } finally {
      await target.cleanup();
    }
  });

  it("requires the local directory to already exist", async () => {
    await expect(
      openWorkspaceDownloadTarget(workspace, "missing", "report.pdf"),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    await expect(stat(path.join(workspace, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["../outside", path.join("nested", "..", "..", "outside")])(
    "rejects the traversal directory %j",
    async (localDirectory) => {
      await expect(
        openWorkspaceDownloadTarget(workspace, localDirectory, "report.pdf"),
      ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    },
  );

  it("rejects an absolute local directory outside the workspace", async () => {
    await expect(
      openWorkspaceDownloadTarget(workspace, outside, "report.pdf"),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
  });

  it("rejects an absolute local directory even when it is inside the workspace", async () => {
    await expect(
      openWorkspaceDownloadTarget(
        workspace,
        path.join(workspace, "nested"),
        "report.pdf",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    expect(await readdir(path.join(workspace, "nested"))).toEqual([]);
  });

  it("rejects a local directory symlink that escapes the workspace", async () => {
    await symlink(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      openWorkspaceDownloadTarget(workspace, "escape", "report.pdf"),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["bad\u0000name.txt", "bad\u0009name.txt", "bad\u007fname.txt"])(
    "rejects control characters in remote name %j",
    async (remoteName) => {
      await expect(
        openWorkspaceDownloadTarget(workspace, undefined, remoteName),
      ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    },
  );

  it.each([
    "keep.txt:stream",
    "bad<name.txt",
    "bad>name.txt",
    "bad:name.txt",
    'bad"name.txt',
    "bad/name.txt",
    "bad\\name.txt",
    "bad|name.txt",
    "bad?name.txt",
    "bad*name.txt",
    "trailing-dot.",
    "trailing-space ",
  ])("rejects Windows-special remote filename %j on every platform", async (remoteName) => {
    await expect(
      openWorkspaceDownloadTarget(workspace, undefined, remoteName),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    expect(fsMocks.open).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it.each([
    "CON",
    "con.txt",
    "PRN.pdf",
    "aux",
    "NUL.txt",
    "COM1.log",
    "com9",
    "LPT1.csv",
    "lpt9.backup.tar",
  ])("rejects reserved DOS device basename %j before any extension", async (remoteName) => {
    await expect(
      openWorkspaceDownloadTarget(workspace, undefined, remoteName),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    expect(fsMocks.open).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("preserves a valid Unicode remote filename", async () => {
    const target = await openWorkspaceDownloadTarget(
      workspace,
      undefined,
      "会议纪要 ①.txt",
    );

    try {
      expect(target.relativePath).toBe("会议纪要 ①.txt");
    } finally {
      await target.cleanup();
    }
  });

  it.each(["", ".", ".."])(
    "rejects a remote name without a safe basename: %j",
    async (remoteName) => {
      await expect(
        openWorkspaceDownloadTarget(workspace, undefined, remoteName),
      ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
    },
  );

  it("cleanup closes and removes only the exact file created by the target", async () => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    const target = await openWorkspaceDownloadTarget(
      workspace,
      undefined,
      "download.txt",
    );
    await target.handle.writeFile("partial");

    await target.cleanup();
    await target.cleanup();

    await expect(stat(path.join(workspace, "download.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(workspace, "keep.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("retries cleanup after a non-EBADF close failure and becomes idempotent after success", async () => {
    const target = await openWorkspaceDownloadTarget(
      workspace,
      undefined,
      "close-retry.txt",
    );
    await target.handle.writeFile("partial");
    const originalClose = target.handle.close.bind(target.handle);
    let closeAttempts = 0;
    target.handle.close = async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) {
        throw Object.assign(new Error("transient close failure"), { code: "EIO" });
      }
      await originalClose();
    };

    await expect(target.cleanup()).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
    await expect(stat(path.join(workspace, "close-retry.txt"))).resolves.toBeDefined();

    await target.cleanup();
    await target.cleanup();

    expect(closeAttempts).toBe(2);
    await expect(stat(path.join(workspace, "close-retry.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retries cleanup after unlink failure and removes only the exact reserved path", async () => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    const target = await openWorkspaceDownloadTarget(
      workspace,
      undefined,
      "unlink-retry.txt",
    );
    const reservedPath = path.join(workspace, target.relativePath);
    await target.handle.close();
    await rm(reservedPath);
    await mkdir(reservedPath);

    await expect(target.cleanup()).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });

    await rm(reservedPath, { recursive: true });
    await writeFile(reservedPath, "replacement at reserved path");
    await target.cleanup();
    await expect(stat(reservedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(reservedPath, "created after successful cleanup");
    await target.cleanup();

    await expect(readFile(reservedPath, "utf8")).resolves.toBe(
      "created after successful cleanup",
    );
    await expect(readFile(path.join(workspace, "keep.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });
});
