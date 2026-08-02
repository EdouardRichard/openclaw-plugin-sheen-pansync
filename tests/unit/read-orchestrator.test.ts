import { describe, expect, it, vi } from "vitest";
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
    resolveEntry: async () => unused(),
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
