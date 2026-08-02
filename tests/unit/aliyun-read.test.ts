import { describe, expect, it, vi } from "vitest";
import { AliyunProvider } from "../../src/providers/aliyun/provider.js";
import type { AliyunFetch } from "../../src/providers/aliyun/types.js";

type RecordedRequest = {
  method: string;
  path: string;
  body?: unknown;
  authorization: string | null;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function resourceDrive(): Record<string, unknown> {
  return {
    user_id: "user-1",
    resource_drive_id: "drive-resource",
    default_drive_id: "drive-default-must-not-be-used",
    backup_drive_id: "drive-backup-must-not-be-used",
  };
}

function makeProvider(fetch: AliyunFetch): AliyunProvider {
  return new AliyunProvider({
    fetch,
    tokenService: { refresh: vi.fn() },
    tokenManager: { forceRefresh: vi.fn(async () => "access-new") },
  });
}

describe("AliyunProvider read primitives", () => {
  it("lists resource-drive entries with a next marker", async () => {
    const requests: RecordedRequest[] = [];
    const fetch: AliyunFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname.endsWith("/getDriveInfo")) return jsonResponse(resourceDrive());
      return jsonResponse({
        items: [{
          file_id: "file-report",
          parent_file_id: "root",
          name: "report.pdf",
          type: "file",
          size: 42,
          updated_at: "2026-08-02T00:00:00.000Z",
        }],
        next_marker: "page-2",
      });
    };
    const provider = makeProvider(fetch);

    const root = await provider.getReadRoot("access-old");
    const page = await provider.listEntries({
      accessToken: "access-old",
      directory: root,
      limit: 20,
    });

    expect(page.entries).toEqual([
      expect.objectContaining({
        id: "file-report",
        parentId: "root",
        name: "report.pdf",
        type: "file",
        size: 42,
        remotePath: "/report.pdf",
      }),
    ]);
    expect(page.nextMarker).toBe("page-2");
    expect(requests.at(-1)?.body).toMatchObject({ drive_id: "drive-resource" });
  });

  it("accepts Aliyun folder entries whose size is null", async () => {
    const fetch: AliyunFetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/getDriveInfo")) return jsonResponse(resourceDrive());
      return jsonResponse({
        items: [{
          file_id: "folder-demo",
          parent_file_id: "root",
          name: "demo",
          type: "folder",
          size: null,
          updated_at: "2026-08-02T00:00:00.000Z",
        }],
        next_marker: "",
      });
    };
    const provider = makeProvider(fetch);
    const root = await provider.getReadRoot("access-old");

    await expect(provider.listEntries({
      accessToken: "access-old",
      directory: root,
      limit: 20,
    })).resolves.toEqual({
      entries: [expect.objectContaining({
        id: "folder-demo",
        name: "demo",
        type: "folder",
        remotePath: "/demo",
      })],
    });
  });

  it("resolves an exact resource-drive path", async () => {
    const requests: RecordedRequest[] = [];
    const fetch: AliyunFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname.endsWith("/getDriveInfo")) return jsonResponse(resourceDrive());
      return jsonResponse({
        file_id: "file-report",
        parent_file_id: "folder-reports",
        name: "report.pdf",
        type: "file",
        size: 42,
      });
    };
    const provider = makeProvider(fetch);

    await expect(provider.resolveEntry("/reports/report.pdf", "access-old"))
      .resolves.toMatchObject({ id: "file-report", type: "file" });
    expect(requests.at(-1)?.path).toBe("/adrive/v1.0/openFile/get_by_path");
  });

  it("treats an empty resource-drive next marker as the final page", async () => {
    const fetch: AliyunFetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/getDriveInfo")) return jsonResponse(resourceDrive());
      return jsonResponse({ items: [], next_marker: "" });
    };
    const provider = makeProvider(fetch);
    const root = await provider.getReadRoot("access-old");

    await expect(provider.listEntries({
      accessToken: "access-old",
      directory: root,
      limit: 20,
    })).resolves.toEqual({ entries: [] });
  });

  it("gets resource-drive file metadata by ID", async () => {
    const requests: RecordedRequest[] = [];
    const fetch: AliyunFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname.endsWith("/getDriveInfo")) return jsonResponse(resourceDrive());
      return jsonResponse({
        file_id: "file-report",
        parent_file_id: "folder-reports",
        name: "report.pdf",
        type: "file",
        size: 42,
      });
    };
    const provider = makeProvider(fetch);

    await expect(provider.getEntryById("file-report", "access-old"))
      .resolves.toMatchObject({ id: "file-report", type: "file", size: 42 });
    expect(requests.at(-1)?.path).toBe("/adrive/v1.0/openFile/get");
  });

  it("opens a signed download stream without authorizing the CDN request", async () => {
    const signedUrl = "https://cdn.example.test/signed/download-secret-CANARY";
    const requests: RecordedRequest[] = [];
    const fetch: AliyunFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname.endsWith("/getDriveInfo")) return jsonResponse(resourceDrive());
      if (url.pathname.endsWith("/getDownloadUrl")) {
        return jsonResponse({ url: signedUrl });
      }
      return new Response(Uint8Array.from([1, 2, 3]));
    };
    const provider = makeProvider(fetch);

    const result = await provider.openDownload({
      accessToken: "access-old",
      entry: {
        id: "file-report",
        parentId: "root",
        name: "report.pdf",
        type: "file",
        size: 3,
        providerState: { driveId: "drive-resource" },
      },
    });

    expect(result).toEqual(expect.objectContaining({ size: 3, stream: expect.anything() }));
    await expect(new Response(result.stream).bytes()).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/signed/download-secret-CANARY",
      authorization: null,
    });
    expect(JSON.stringify(result)).not.toContain("download-secret-CANARY");
  });
});
