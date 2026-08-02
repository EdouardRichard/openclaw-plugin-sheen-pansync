import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { PanSyncError } from "../../src/errors.js";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchCursorState,
  type SearchIdentity,
} from "../../src/read/cursor.js";

const identity: SearchIdentity = {
  provider: "aliyun",
  remoteDirectory: "/共享",
  query: "报告",
  limit: 20,
};

const state: SearchCursorState = {
  v: 1,
  identity,
  pending: [
    { id: "folder-a", path: "/共享/A", marker: "page-2" },
    { id: "folder-b", path: "/共享/B" },
  ],
  buffered: [
    {
      fileId: "file-1",
      name: "报告.txt",
      type: "file",
      size: 7,
      updatedAt: "2026-08-02T12:00:00.000Z",
      remotePath: "/共享/报告.txt",
    },
  ],
};

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function expectInvalid(cursor: string, currentIdentity = identity): void {
  let rejected: unknown;
  try {
    decodeSearchCursor(cursor, currentIdentity);
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(PanSyncError);
  expect(rejected).toMatchObject({ code: "REMOTE_DIRECTORY_FAILED" });
  expect(String((rejected as Error).message)).not.toContain(cursor);
}

describe("search cursor codec", () => {
  it("round-trips only the bounded resumable search state", () => {
    const cursor = encodeSearchCursor(state);

    expect(decodeSearchCursor(cursor, identity)).toEqual(state);
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
      .toEqual(state);
  });

  it("emits a near-limit cursor within the input byte ceiling that decodes", () => {
    const nearLimitState: SearchCursorState = {
      v: 1,
      identity: {
        ...identity,
        query: "界".repeat(16_250),
      },
      pending: [],
      buffered: [],
    };

    const cursor = encodeSearchCursor(nearLimitState);

    expect(Buffer.byteLength(cursor, "utf8")).toBeGreaterThan(65_000);
    expect(Buffer.byteLength(cursor, "utf8")).toBeLessThanOrEqual(65_536);
    expect(decodeSearchCursor(cursor, nearLimitState.identity))
      .toEqual(nearLimitState);
  });

  it("rejects a state whose base64url cursor would exceed the input byte ceiling", () => {
    const encodedOversizeState: SearchCursorState = {
      v: 1,
      identity: {
        ...identity,
        query: "x".repeat(49_100),
      },
      pending: [],
      buffered: [],
    };

    expect(() => encodeSearchCursor(encodedOversizeState))
      .toThrowError(PanSyncError);
  });

  it("maps malformed and oversized cursor input to a stable safe error", () => {
    expectInvalid("not-base64");
    expectInvalid("a".repeat(65_537));
    expect(() => decodeSearchCursor("not-base64", identity))
      .toThrowError(PanSyncError);
  });

  it.each([
    ["provider", { ...identity, provider: "other" }],
    ["root directory", { ...identity, remoteDirectory: "/别处" }],
    ["query", { ...identity, query: "预算" }],
    ["limit", { ...identity, limit: 21 }],
  ] as const)("rejects a cursor whose %s differs from the call", (_name, changed) => {
    expectInvalid(encodeSearchCursor(state), changed as SearchIdentity);
  });

  it.each([
    ["unknown version", { ...state, v: 2 }],
    [
      "too many pending directories",
      {
        ...state,
        pending: Array.from({ length: 513 }, (_, index) => ({
          id: `folder-${index}`,
          path: `/共享/${index}`,
        })),
      },
    ],
    [
      "too many buffered matches",
      {
        ...state,
        buffered: Array.from({ length: 101 }, (_, index) => ({
          fileId: `file-${index}`,
          name: `报告-${index}`,
          type: "file",
        })),
      },
    ],
    [
      "control character in identity",
      { ...state, identity: { ...identity, query: "报告\u0000" } },
    ],
    [
      "control character in pending directory",
      { ...state, pending: [{ id: "folder-a", path: "/共享/\u0000" }] },
    ],
    [
      "control character in buffered metadata",
      {
        ...state,
        buffered: [{ fileId: "file-1", name: "报告\u0000", type: "file" }],
      },
    ],
    ["missing pending ID", { ...state, pending: [{ id: "", path: "/共享" }] }],
    [
      "missing buffered file ID",
      { ...state, buffered: [{ fileId: "", name: "报告", type: "file" }] },
    ],
    ["unexpected provider state", { ...state, providerState: { driveId: "secret" } }],
  ])("rejects %s", (_name, invalidState) => {
    expectInvalid(rawCursor(invalidState));
  });

  it("validates decoded bytes before parsing JSON", () => {
    const oversizedDecodedCursor = Buffer.alloc(65_537, 0x20).toString("base64url");

    expectInvalid(oversizedDecodedCursor);
  });
});
