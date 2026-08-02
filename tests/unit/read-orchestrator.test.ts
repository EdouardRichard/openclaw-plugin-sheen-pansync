import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudDriveProvider,
  RemoteEntry,
  RemoteEntryPage,
} from "../../src/contracts.js";
import { PanSyncError } from "../../src/errors.js";
import { ReadOrchestrator } from "../../src/read/orchestrator.js";

function unused(): never {
  throw new Error("unused fake provider operation");
}

function makeHarness(pages: RemoteEntryPage[]) {
  const listEntries = vi.fn<CloudDriveProvider["listEntries"]>(async () => {
    const page = pages.shift();
    if (page === undefined) {
      throw new Error("unexpected provider page request");
    }
    return page;
  });
  const provider: CloudDriveProvider = {
    id: "aliyun",
    aliases: ["aliyun"],
    validateCredentials: async () => unused(),
    ensureDirectory: async () => unused(),
    getReadRoot: vi.fn(async () => ({
      id: "root",
      path: "/",
      providerState: { driveId: "drive-secret" },
    })),
    resolveEntry: vi.fn(async () => unused()),
    getEntryById: async () => unused(),
    listEntries,
    openDownload: async () => unused(),
    uploadFile: async () => unused(),
  };
  const providerRegistry = { resolve: vi.fn(() => provider) };
  const tokenManager = {
    getValidAccessToken: vi.fn(async () => "access-secret"),
  };
  return {
    orchestrator: new ReadOrchestrator({ providerRegistry, tokenManager }),
    listEntries,
    provider,
    providerRegistry,
    tokenManager,
  };
}

function folder(id: string, name: string, parentId = "root"): RemoteEntry {
  return {
    id,
    parentId,
    name,
    type: "folder",
    remotePath: parentId === "root" ? `/${name}` : `/${parentId}/${name}`,
    providerState: { driveId: "drive-secret" },
  };
}

function file(id: string, name: string, parentId = "root"): RemoteEntry {
  return {
    id,
    parentId,
    name,
    type: "file",
    size: id.length,
    remotePath: parentId === "root" ? `/${name}` : `/${parentId}/${name}`,
    providerState: { driveId: "drive-secret", signedUrl: "signed-secret" },
  };
}

function byteStream(size: number, chunkSize = 1024 * 1024): ReadableStream<Uint8Array> {
  let remaining = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const length = Math.min(remaining, chunkSize);
      remaining -= length;
      controller.enqueue(new Uint8Array(length).fill(0x61));
    },
  });
}

function makeDownloadHarness(
  entry: RemoteEntry,
  openDownload: CloudDriveProvider["openDownload"] = async () => ({
    stream: byteStream(entry.size ?? 0),
    size: entry.size ?? 0,
  }),
) {
  const provider: CloudDriveProvider = {
    id: "aliyun",
    aliases: ["aliyun"],
    validateCredentials: async () => unused(),
    ensureDirectory: async () => unused(),
    getReadRoot: async () => unused(),
    resolveEntry: vi.fn(async () => entry),
    getEntryById: vi.fn(async () => entry),
    listEntries: async () => unused(),
    openDownload: vi.fn(openDownload),
    uploadFile: async () => unused(),
  };
  const providerRegistry = { resolve: vi.fn(() => provider) };
  const tokenManager = {
    getValidAccessToken: vi.fn(async () => "access-secret"),
  };
  return {
    orchestrator: new ReadOrchestrator({ providerRegistry, tokenManager }),
    provider,
    providerRegistry,
    tokenManager,
  };
}

describe("ReadOrchestrator direct directory listing", () => {
  it("defaults to the root and limit 20, reads one page, and projects metadata only", async () => {
    const harness = makeHarness([{
      entries: [
        {
          id: "folder-1",
          parentId: "root",
          name: "资料",
          type: "folder",
          remotePath: "/资料",
          providerState: { driveId: "drive-secret", signedUrl: "secret-url" },
        },
        {
          id: "file-1",
          parentId: "root",
          name: "report.txt",
          type: "file",
          size: 42,
          updatedAt: "2026-08-02T12:00:00.000Z",
          remotePath: "/report.txt",
          providerState: { driveId: "drive-secret", signedUrl: "secret-url" },
        },
      ],
    }]);

    const result = await harness.orchestrator.list({});

    expect(result).toEqual({
      provider: "aliyun",
      remoteDirectory: "/",
      entries: [
        {
          fileId: "folder-1",
          name: "资料",
          type: "folder",
          remotePath: "/资料",
        },
        {
          fileId: "file-1",
          name: "report.txt",
          type: "file",
          size: 42,
          updatedAt: "2026-08-02T12:00:00.000Z",
          remotePath: "/report.txt",
        },
      ],
    });
    expect(harness.listEntries).toHaveBeenCalledOnce();
    expect(harness.listEntries).toHaveBeenCalledWith({
      accessToken: "access-secret",
      directory: {
        id: "root",
        path: "/",
        providerState: { driveId: "drive-secret" },
      },
      limit: 20,
    }, {});
    expect(JSON.stringify(result)).not.toContain("providerState");
    expect(JSON.stringify(result)).not.toContain("drive-secret");
    expect(JSON.stringify(result)).not.toContain("secret-url");
  });

  it("continues the same exact directory with the provider marker", async () => {
    const harness = makeHarness([
      {
        entries: [{
          id: "file-1",
          parentId: "folder-reports",
          name: "first.txt",
          type: "file",
          providerState: { driveId: "drive-secret" },
        }],
        nextMarker: "provider-page-2",
      },
      {
        entries: [{
          id: "file-2",
          parentId: "folder-reports",
          name: "second.txt",
          type: "file",
          providerState: { driveId: "drive-secret" },
        }],
      },
    ]);
    harness.provider.resolveEntry = vi.fn(async () => ({
      id: "folder-reports",
      parentId: "root",
      name: "reports",
      type: "folder" as const,
      remotePath: "/reports",
      providerState: { driveId: "drive-secret" },
    }));

    const first = await harness.orchestrator.list({
      remoteDirectory: "//reports",
      limit: 1,
    });
    const second = await harness.orchestrator.list({
      remoteDirectory: "/reports",
      limit: 1,
      cursor: first.nextCursor!,
    });

    expect(first.entries.map(({ fileId }) => fileId)).toEqual(["file-1"]);
    expect(second.entries.map(({ fileId }) => fileId)).toEqual(["file-2"]);
    expect(second.nextCursor).toBeUndefined();
    expect(harness.listEntries).toHaveBeenCalledTimes(2);
    expect(harness.listEntries.mock.calls[1]?.[0]).toMatchObject({
      directory: { id: "folder-reports", path: "/reports" },
      marker: "provider-page-2",
      limit: 1,
    });
  });

  it.each([0, 101, 1.5, Number.NaN])("rejects invalid limit %s before provider I/O", async (limit) => {
    const harness = makeHarness([]);

    await expect(harness.orchestrator.list({ limit }))
      .rejects.toMatchObject({ code: "REMOTE_DIRECTORY_FAILED" });
    expect(harness.providerRegistry.resolve).not.toHaveBeenCalled();
    expect(harness.tokenManager.getValidAccessToken).not.toHaveBeenCalled();
  });

  it("does not treat a file as a directory", async () => {
    const harness = makeHarness([]);
    harness.provider.resolveEntry = vi.fn(async () => ({
      id: "file-1",
      parentId: "root",
      name: "report.txt",
      type: "file" as const,
      providerState: { driveId: "drive-secret" },
    }));

    await expect(harness.orchestrator.list({ remoteDirectory: "/report.txt" }))
      .rejects.toBeInstanceOf(PanSyncError);
    expect(harness.listEntries).not.toHaveBeenCalled();
  });
});

describe("ReadOrchestrator bounded breadth-first search", () => {
  it("returns breadth-first Chinese-name and case-insensitive English matches", async () => {
    const harness = makeHarness([
      {
        entries: [
          folder("folder-a", "中文目录A"),
          folder("folder-b", "目录B"),
          file("root-miss", "notes.txt"),
        ],
      },
      {
        entries: [file("match-a", "年度 Report 报告.txt", "folder-a")],
      },
      {
        entries: [file("match-b", "REPORT-final.txt", "folder-b")],
      },
    ]);

    const result = await harness.orchestrator.list({ query: "report" });

    expect(result).toEqual({
      provider: "aliyun",
      remoteDirectory: "/",
      query: "report",
      entries: [
        {
          fileId: "match-a",
          name: "年度 Report 报告.txt",
          type: "file",
          size: 7,
          remotePath: "/folder-a/年度 Report 报告.txt",
        },
        {
          fileId: "match-b",
          name: "REPORT-final.txt",
          type: "file",
          size: 7,
          remotePath: "/folder-b/REPORT-final.txt",
        },
      ],
    });
    expect(harness.listEntries.mock.calls.map(([input]) => input.directory.id))
      .toEqual(["root", "folder-a", "folder-b"]);
    expect(harness.listEntries.mock.calls.every(([input]) => input.limit === 100))
      .toBe(true);
    expect(JSON.stringify(result)).not.toContain("providerState");
    expect(JSON.stringify(result)).not.toContain("signed-secret");
  });

  it("uses NFC normalization for Unicode containment", async () => {
    const harness = makeHarness([{
      entries: [file("match-cn", "项目-é-报告.txt")],
    }]);

    const result = await harness.orchestrator.list({ query: "e\u0301-报告" });

    expect(result.entries.map(({ fileId }) => fileId)).toEqual(["match-cn"]);
  });

  it("buffers every already-fetched match and resumes without skips, repeats, or extra calls", async () => {
    const harness = makeHarness([{
      entries: [
        file("match-1", "hit-1.txt"),
        file("match-2", "hit-2.txt"),
        file("match-3", "hit-3.txt"),
      ],
    }]);

    const first = await harness.orchestrator.list({ query: "hit", limit: 1 });
    const callsAfterFirst = harness.listEntries.mock.calls.length;
    const second = await harness.orchestrator.list({
      query: "hit",
      limit: 1,
      cursor: first.nextCursor!,
    });
    const third = await harness.orchestrator.list({
      query: "hit",
      limit: 1,
      cursor: second.nextCursor!,
    });

    expect([
      first.entries[0]?.fileId,
      second.entries[0]?.fileId,
      third.entries[0]?.fileId,
    ]).toEqual(["match-1", "match-2", "match-3"]);
    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(1);
    expect(third.entries).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(second.nextCursor).toBeTypeOf("string");
    expect(third.nextCursor).toBeUndefined();
    expect(callsAfterFirst).toBe(1);
    expect(harness.listEntries).toHaveBeenCalledOnce();
    const cursorJson = Buffer.from(first.nextCursor!, "base64url").toString("utf8");
    expect(cursorJson).not.toContain("drive-secret");
    expect(cursorJson).not.toContain("signed-secret");
    expect(cursorJson).not.toContain("access-secret");
  });

  it("returns a buffered resume without token or Provider calls", async () => {
    const harness = makeHarness([{
      entries: [
        file("match-1", "hit-1.txt"),
        file("match-2", "hit-2.txt"),
        file("match-3", "hit-3.txt"),
      ],
    }]);
    const first = await harness.orchestrator.list({ query: "hit", limit: 1 });
    harness.tokenManager.getValidAccessToken.mockClear();
    vi.mocked(harness.provider.getReadRoot).mockClear();
    vi.mocked(harness.provider.resolveEntry).mockClear();
    harness.listEntries.mockClear();

    const resumed = await harness.orchestrator.list({
      query: "hit",
      limit: 1,
      cursor: first.nextCursor!,
    });

    expect(resumed.entries.map(({ fileId }) => fileId)).toEqual(["match-2"]);
    expect(resumed.nextCursor).toBeTypeOf("string");
    expect(harness.tokenManager.getValidAccessToken).not.toHaveBeenCalled();
    expect(harness.provider.getReadRoot).not.toHaveBeenCalled();
    expect(harness.provider.resolveEntry).not.toHaveBeenCalled();
    expect(harness.listEntries).not.toHaveBeenCalled();
  });

  it("stops at 20 provider pages and resumes the remaining breadth-first work", async () => {
    const childFolders = Array.from({ length: 25 }, (_, index) =>
      folder(`folder-${index}`, `folder-${index}`));
    const pages: RemoteEntryPage[] = [
      { entries: childFolders },
      ...childFolders.map((child, index) => ({
        entries: [file(`match-${index}`, `hit-${index}.txt`, child.id)],
      })),
    ];
    const harness = makeHarness(pages);

    const first = await harness.orchestrator.list({ query: "hit", limit: 100 });

    expect(harness.listEntries).toHaveBeenCalledTimes(20);
    expect(first.entries.map(({ fileId }) => fileId)).toEqual(
      Array.from({ length: 19 }, (_, index) => `match-${index}`),
    );
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await harness.orchestrator.list({
      query: "hit",
      limit: 100,
      cursor: first.nextCursor!,
    });

    expect(harness.listEntries).toHaveBeenCalledTimes(26);
    expect(second.entries.map(({ fileId }) => fileId)).toEqual(
      Array.from({ length: 6 }, (_, index) => `match-${index + 19}`),
    );
    expect(second.nextCursor).toBeUndefined();
  });

  it("rejects more than 512 pending folders without leaking their IDs", async () => {
    const canaryId = "folder-secret-CANARY";
    const harness = makeHarness([{
      entries: Array.from({ length: 513 }, (_, index) =>
        folder(index === 512 ? canaryId : `folder-${index}`, `folder-${index}`)),
    }]);

    let rejected: unknown;
    try {
      await harness.orchestrator.list({ query: "never-matches" });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(PanSyncError);
    expect(rejected).toMatchObject({ code: "REMOTE_DIRECTORY_FAILED" });
    expect(String((rejected as Error).message)).not.toContain(canaryId);
    expect(harness.listEntries).toHaveBeenCalledOnce();
  });
});

describe("ReadOrchestrator download", () => {
  const threshold = 104_857_600;
  let fixtureRoot: string;
  let workspace: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pan-sync-download-"));
    workspace = path.join(fixtureRoot, "workspace");
    await mkdir(path.join(workspace, "nested"), { recursive: true });
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("downloads exactly 100 MiB to the workspace root", async () => {
    const entry = { ...file("file-limit", "limit.bin"), size: threshold };
    const harness = makeDownloadHarness(entry);

    const result = await harness.orchestrator.download({
      workspaceDir: workspace,
      fileId: entry.id,
    });

    expect(result).toEqual({
      provider: "aliyun",
      remoteName: "limit.bin",
      localPath: "limit.bin",
      size: threshold,
      status: "downloaded",
    });
    await expect(stat(path.join(workspace, "limit.bin"))).resolves.toMatchObject({
      size: threshold,
    });
    expect(JSON.stringify(result)).not.toContain(workspace);
    expect(JSON.stringify(result)).not.toContain("access-secret");
    expect(JSON.stringify(result)).not.toContain("providerState");
  });

  it("requires confirmation above 100 MiB before opening a stream or local file", async () => {
    const entry = { ...file("file-large", "large.bin"), size: threshold + 1 };
    const harness = makeDownloadHarness(entry);

    const result = await harness.orchestrator.download({
      workspaceDir: workspace,
      remotePath: "/large.bin",
    });

    expect(result).toEqual({
      provider: "aliyun",
      remoteName: "large.bin",
      fileId: "file-large",
      size: threshold + 1,
      status: "confirmation_required",
      code: "DOWNLOAD_CONFIRMATION_REQUIRED",
    });
    expect(harness.provider.openDownload).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("downloads a confirmed file above 100 MiB", async () => {
    const size = threshold + 1;
    const entry = { ...file("file-large", "large.bin"), size };
    const harness = makeDownloadHarness(entry);

    const result = await harness.orchestrator.download({
      workspaceDir: workspace,
      fileId: entry.id,
      confirmedLargeDownload: true,
    });

    expect(result).toMatchObject({
      localPath: "large.bin",
      size,
      status: "downloaded",
    });
    await expect(stat(path.join(workspace, "large.bin"))).resolves.toMatchObject({
      size,
    });
  });

  it("resolves an ordinary remote path and writes exact bytes to an existing nested directory", async () => {
    const entry = { ...file("file-report", "report.txt"), size: 6 };
    const harness = makeDownloadHarness(entry, async () => ({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abc"));
          controller.enqueue(new TextEncoder().encode("123"));
          controller.close();
        },
      }),
      size: 6,
    }));

    const result = await harness.orchestrator.download({
      workspaceDir: workspace,
      remotePath: "/reports/report.txt",
      localDirectory: "nested",
    });

    expect(result).toEqual({
      provider: "aliyun",
      remoteName: "report.txt",
      localPath: "nested/report.txt",
      size: 6,
      status: "downloaded",
    });
    await expect(
      readFile(path.join(workspace, "nested", "report.txt"), "utf8"),
    ).resolves.toBe("abc123");
    expect(harness.provider.resolveEntry).toHaveBeenCalledWith(
      "/reports/report.txt",
      "access-secret",
      {},
    );
    expect(harness.provider.getEntryById).not.toHaveBeenCalled();
  });

  it("resolves a file ID without resolving a path", async () => {
    const entry = { ...file("file-id", "id.txt"), size: 1 };
    const harness = makeDownloadHarness(entry);

    await harness.orchestrator.download({
      workspaceDir: workspace,
      fileId: entry.id,
    });

    expect(harness.provider.getEntryById).toHaveBeenCalledWith(
      entry.id,
      "access-secret",
      {},
    );
    expect(harness.provider.resolveEntry).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { fileId: "file-id", remotePath: "/id.txt" },
  ])("rejects a non-unique target before token or provider I/O: %j", async (target) => {
    const entry = { ...file("file-id", "id.txt"), size: 1 };
    const harness = makeDownloadHarness(entry);

    await expect(
      harness.orchestrator.download({ workspaceDir: workspace, ...target }),
    ).rejects.toMatchObject({ code: "REMOTE_FILE_AMBIGUOUS" });
    expect(harness.tokenManager.getValidAccessToken).not.toHaveBeenCalled();
    expect(harness.provider.resolveEntry).not.toHaveBeenCalled();
    expect(harness.provider.getEntryById).not.toHaveBeenCalled();
    expect(harness.provider.openDownload).not.toHaveBeenCalled();
  });

  it("rejects a directory before opening a stream or local file", async () => {
    const harness = makeDownloadHarness(folder("folder-reports", "reports"));

    await expect(
      harness.orchestrator.download({
        workspaceDir: workspace,
        fileId: "folder-reports",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_ENTRY_NOT_FILE" });
    expect(harness.provider.openDownload).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("rejects missing size metadata before opening a stream or local file", async () => {
    const entry = file("file-no-size", "unknown.bin");
    delete entry.size;
    const harness = makeDownloadHarness(entry);

    await expect(
      harness.orchestrator.download({
        workspaceDir: workspace,
        fileId: entry.id,
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(harness.provider.openDownload).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("preserves the stable missing-file error without leaking provider details", async () => {
    const entry = { ...file("missing", "missing.txt"), size: 1 };
    const harness = makeDownloadHarness(entry);
    vi.mocked(harness.provider.getEntryById).mockRejectedValue(
      new PanSyncError("REMOTE_FILE_NOT_FOUND"),
    );

    let rejected: unknown;
    try {
      await harness.orchestrator.download({
        workspaceDir: workspace,
        fileId: entry.id,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({ code: "REMOTE_FILE_NOT_FOUND" });
    expect(JSON.stringify(rejected)).not.toContain("access-secret");
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("cancels and removes the partial local file", async () => {
    const controller = new AbortController();
    let pullCount = 0;
    const entry = { ...file("file-abort", "abort.txt"), size: 2 };
    const harness = makeDownloadHarness(entry, async () => ({
      stream: new ReadableStream<Uint8Array>({
        pull(streamController) {
          pullCount += 1;
          if (pullCount === 1) {
            streamController.enqueue(Uint8Array.of(0x61));
            return;
          }
          controller.abort();
          streamController.enqueue(Uint8Array.of(0x62));
          streamController.close();
        },
      }),
      size: 2,
    }));

    await expect(
      harness.orchestrator.download(
        { workspaceDir: workspace, fileId: entry.id },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("rejects a short stream and removes the partial local file", async () => {
    const entry = { ...file("file-short", "short.txt"), size: 4 };
    const harness = makeDownloadHarness(entry, async () => ({
      stream: byteStream(3),
      size: 4,
    }));

    await expect(
      harness.orchestrator.download({ workspaceDir: workspace, fileId: entry.id }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("rejects a long stream as soon as it exceeds metadata and removes it", async () => {
    const entry = { ...file("file-long", "long.txt"), size: 3 };
    const harness = makeDownloadHarness(entry, async () => ({
      stream: byteStream(4),
      size: 3,
    }));

    await expect(
      harness.orchestrator.download({ workspaceDir: workspace, fileId: entry.id }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("removes only this call's collision file after a provider failure", async () => {
    const canary = "signed-url-secret-CANARY";
    await writeFile(path.join(workspace, "report.txt"), "keep me");
    const entry = { ...file("file-provider", "report.txt"), size: 4 };
    const harness = makeDownloadHarness(entry, async () => {
      throw new Error(`provider failed at ${canary} in ${workspace}`);
    });

    let rejected: unknown;
    try {
      await harness.orchestrator.download({
        workspaceDir: workspace,
        fileId: entry.id,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(JSON.stringify(rejected)).not.toContain(canary);
    expect(JSON.stringify(rejected)).not.toContain(workspace);
    expect(await readdir(workspace)).toEqual(["nested", "report.txt"]);
    await expect(readFile(path.join(workspace, "report.txt"), "utf8")).resolves.toBe(
      "keep me",
    );
  });

  it("removes the partial file when the response stream fails", async () => {
    const entry = { ...file("file-network", "network.txt"), size: 2 };
    let pullCount = 0;
    const harness = makeDownloadHarness(entry, async () => ({
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) {
            controller.enqueue(Uint8Array.of(0x61));
            return;
          }
          controller.error(new Error("network raw response secret"));
        },
      }),
      size: 2,
    }));

    await expect(
      harness.orchestrator.download({ workspaceDir: workspace, fileId: entry.id }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(await readdir(workspace)).toEqual(["nested"]);
  });

  it("maps a local write rejection and removes the created file", async () => {
    const entry = { ...file("file-write", "write.txt"), size: 1 };
    const harness = makeDownloadHarness(entry, async () => ({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue({ byteLength: 1 } as Uint8Array);
          controller.close();
        },
      }),
      size: 1,
    }));

    await expect(
      harness.orchestrator.download({ workspaceDir: workspace, fileId: entry.id }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(await readdir(workspace)).toEqual(["nested"]);
  });
});
