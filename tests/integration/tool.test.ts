import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type {
  PanSyncDownloadResult,
  PanSyncListResult,
  PanSyncUploadResult,
} from "../../src/contracts.js";
import { PanSyncError } from "../../src/errors.js";
import {
  registerPanSyncReadTools,
  type PanSyncReadToolApi,
} from "../../src/read/tool.js";
import type { ReadOrchestrator } from "../../src/read/orchestrator.js";
import {
  registerPanSyncUploadTool,
  type PanSyncUploadToolApi,
} from "../../src/tool.js";
import type { UploadOrchestrator } from "../../src/upload/orchestrator.js";
import { withOpenClawInstallLease } from "../helpers/openclaw-install-lease.mjs";

type ToolRegistration = Parameters<PanSyncUploadToolApi["registerTool"]>[0];
type CapturedTool = ReturnType<ToolRegistration>;
type ReadToolRegistration = Parameters<PanSyncReadToolApi["registerTool"]>[0];
type CapturedReadTool = ReturnType<ReadToolRegistration>;

const require = createRequire(import.meta.url);

function resolveOpenClawCliEntry(
  resolveModule: (specifier: string) => string = require.resolve,
) {
  return resolveModule("openclaw/cli-entry");
}

function runOpenClaw(args: readonly string[], stateDir: string) {
  const cliPath = resolveOpenClawCliEntry();
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const supportedCurrentNode =
    nodeMajor > 22 ||
    (nodeMajor === 22 && Number.parseInt(process.versions.node.split(".")[1] ?? "0", 10) >= 22);
  const command = supportedCurrentNode ? process.execPath : "volta";
  const commandArgs = supportedCurrentNode
    ? [cliPath, ...args]
    : ["run", "--node", "22.23.1", "node", cliPath, ...args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NO_COLOR: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;

  return spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 90_000,
  });
}

function captureTool(
  orchestrator: Pick<UploadOrchestrator, "upload">,
  workspaceDir?: string,
): CapturedTool {
  let registration: ToolRegistration | undefined;
  const api: PanSyncUploadToolApi = {
    registerTool(candidate: ToolRegistration) {
      registration = candidate;
    },
  };

  registerPanSyncUploadTool(api, orchestrator);

  if (registration === undefined) {
    throw new Error("expected a Tool factory registration");
  }
  return registration(workspaceDir === undefined ? {} : { workspaceDir });
}

function captureReadTools(
  orchestrator: Pick<ReadOrchestrator, "list" | "download">,
  workspaceDir?: string,
): Map<string, CapturedReadTool> {
  const registrations = new Map<string, ReadToolRegistration>();
  const api: PanSyncReadToolApi = {
    registerTool(candidate, options) {
      registrations.set(options?.name ?? "", candidate);
    },
  };

  registerPanSyncReadTools(api, orchestrator);

  return new Map(
    [...registrations].map(([name, factory]) => [
      name,
      factory(workspaceDir === undefined ? {} : { workspaceDir }),
    ]),
  );
}

function requiredReadTool<Name extends CapturedReadTool["name"]>(
  tools: Map<string, CapturedReadTool>,
  name: Name,
): Extract<CapturedReadTool, { name: Name }> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`expected ${name} registration`);
  return tool as Extract<CapturedReadTool, { name: Name }>;
}

describe("pan_sync_upload Tool", () => {
  it("registers the exact bounded upload schema", () => {
    const tool = captureTool({
      upload: vi.fn(async () => {
        throw new Error("not executed");
      }),
    });

    expect(tool.name).toBe("pan_sync_upload");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 100,
        },
        provider: { const: "aliyun", type: "string" },
        remoteDirectory: { type: "string", minLength: 1 },
      },
      required: ["paths"],
      additionalProperties: false,
    });
  });

  it("enforces schema bounds and rejects undeclared input properties", () => {
    const tool = captureTool({
      upload: vi.fn(async () => {
        throw new Error("not executed");
      }),
    });

    expect(Value.Check(tool.parameters, { paths: ["report.pdf"] })).toBe(true);
    expect(Value.Check(tool.parameters, { paths: [] })).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        paths: Array.from({ length: 101 }, () => "report.pdf"),
      }),
    ).toBe(false);
    expect(Value.Check(tool.parameters, { paths: [""] })).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        paths: ["report.pdf"],
        provider: "other",
      }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        paths: ["report.pdf"],
        remoteDirectory: "",
      }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        paths: ["report.pdf"],
        workspaceDir: "C:\\forged",
      }),
    ).toBe(false);
  });

  it("uses only the factory workspace context and returns the safe result as OpenClaw JSON", async () => {
    const workspaceDir = "C:\\private\\openclaw\\workspace";
    const safeResult: PanSyncUploadResult = {
      provider: "aliyun",
      remoteDirectory: "/openClawShare",
      status: "success",
      files: [
        {
          inputName: "report.pdf",
          remoteName: "report.pdf",
          size: 42,
          status: "uploaded",
        },
      ],
    };
    const runtimeResult = {
      ...safeResult,
      accessToken: "access-token-CANARY",
      credentials: { refreshToken: "refresh-token-CANARY" },
      workspaceDir,
      files: safeResult.files.map((file) => ({
        ...file,
        runtime: {
          accessToken: "access-token-CANARY",
          workspacePath: workspaceDir,
        },
      })),
    } as unknown as PanSyncUploadResult;
    let receivedInput: unknown;
    const tool = captureTool(
      {
        upload: vi.fn(async (input) => {
          receivedInput = input;
          return runtimeResult;
        }),
      },
      workspaceDir,
    );

    const result = await tool.execute("call-1", {
      paths: ["report.pdf"],
      provider: "aliyun",
      remoteDirectory: "/openClawShare",
    });

    expect(receivedInput).toEqual({
      workspaceDir,
      paths: ["report.pdf"],
      provider: "aliyun",
      remoteDirectory: "/openClawShare",
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(safeResult, null, 2),
        },
      ],
      details: safeResult,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access-token-CANARY");
    expect(serialized).not.toContain("refresh-token-CANARY");
    expect(serialized).not.toContain(workspaceDir);
  });

  it("returns a stable redacted error without exposing native error details", async () => {
    const workspaceDir = "C:\\private\\openclaw\\workspace";
    const tool = captureTool(
      {
        upload: vi.fn(async () => {
          throw new Error(
            `request failed access-token-CANARY refresh-token-CANARY at ${workspaceDir}`,
          );
        }),
      },
      workspaceDir,
    );

    const result = await tool.execute("call-2", { paths: ["report.pdf"] });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: "UPLOAD_FAILED" }, null, 2),
        },
      ],
      details: { code: "UPLOAD_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(JSON.stringify(result)).not.toContain(workspaceDir);
  });

  it("preserves stable domain errors", async () => {
    const tool = captureTool(
      {
        upload: vi.fn(async () => {
          throw new PanSyncError("CREDENTIALS_REQUIRED");
        }),
      },
      "C:\\private\\openclaw\\workspace",
    );

    const result = await tool.execute("call-3", { paths: ["report.pdf"] });

    expect(result.details).toEqual({ code: "CREDENTIALS_REQUIRED" });
  });

  it("rejects execution when OpenClaw supplies no workspace authority", async () => {
    let uploadCalled = false;
    const tool = captureTool({
      upload: vi.fn(async () => {
        uploadCalled = true;
        throw new Error("must not execute");
      }),
    });

    const result = await tool.execute("call-4", { paths: ["report.pdf"] });

    expect(uploadCalled).toBe(false);
    expect(result.details).toEqual({ code: "WORKSPACE_PATH_REJECTED" });
  });
});

describe("resource drive read Tools", () => {
  function inertReadOrchestrator(): Pick<ReadOrchestrator, "list" | "download"> {
    return {
      list: vi.fn(async () => {
        throw new Error("not executed");
      }),
      download: vi.fn(async () => {
        throw new Error("not executed");
      }),
    };
  }

  it("registers only the list and download Tools with their exact bounded schemas", () => {
    const tools = captureReadTools(inertReadOrchestrator());

    expect([...tools.keys()]).toEqual(["pan_sync_list", "pan_sync_download"]);
    const listTool = requiredReadTool(tools, "pan_sync_list");
    expect(listTool.name).toBe("pan_sync_list");
    expect(listTool.parameters).toEqual({
      type: "object",
      properties: {
        provider: { const: "aliyun", type: "string" },
        remoteDirectory: { type: "string", minLength: 1 },
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", minLength: 1, maxLength: 65_536 },
      },
      additionalProperties: false,
    });

    const downloadTool = requiredReadTool(tools, "pan_sync_download");
    expect(downloadTool.name).toBe("pan_sync_download");
    expect(downloadTool.description).toMatch(/workspace root/iu);
    expect(downloadTool.description).toMatch(/missing director(?:y|ies).*creat/iu);
    expect(downloadTool.description).toMatch(/wait internally|internal queue/iu);
    expect(downloadTool.description).toMatch(/do not.*duplicate|do not.*retry/iu);
    expect(downloadTool.parameters).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            provider: { const: "aliyun", type: "string" },
            fileId: { type: "string", minLength: 1 },
            localDirectory: { type: "string", minLength: 1 },
            confirmedLargeDownload: { type: "boolean" },
          },
          required: ["fileId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            provider: { const: "aliyun", type: "string" },
            remotePath: { type: "string", minLength: 1 },
            localDirectory: { type: "string", minLength: 1 },
            confirmedLargeDownload: { type: "boolean" },
          },
          required: ["remotePath"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("defaults to the workspace root without deriving a local directory from remotePath", async () => {
    const workspaceDir = "C:\\private\\openclaw\\workspace";
    const download = vi.fn(async () => ({
      provider: "aliyun" as const,
      remoteName: "report.pdf",
      localPath: "report.pdf",
      size: 1,
      status: "downloaded" as const,
    }));
    const tool = requiredReadTool(captureReadTools({
      list: vi.fn(async () => {
        throw new Error("not executed");
      }),
      download,
    }, workspaceDir), "pan_sync_download");

    await tool.execute("download-root", {
      remotePath: "/remote/folder/report.pdf",
    });

    expect(download).toHaveBeenCalledWith({
      workspaceDir,
      remotePath: "/remote/folder/report.pdf",
    });
  });

  it("rejects out-of-bounds list input and undeclared authority or secret fields", () => {
    const tool = requiredReadTool(
      captureReadTools(inertReadOrchestrator()),
      "pan_sync_list",
    );

    expect(Value.Check(tool.parameters, {})).toBe(true);
    expect(Value.Check(tool.parameters, { limit: 1 })).toBe(true);
    expect(Value.Check(tool.parameters, { limit: 100 })).toBe(true);
    expect(Value.Check(tool.parameters, { limit: 0 })).toBe(false);
    expect(Value.Check(tool.parameters, { limit: 101 })).toBe(false);
    expect(Value.Check(tool.parameters, { limit: 1.5 })).toBe(false);
    expect(Value.Check(tool.parameters, { cursor: "" })).toBe(false);
    expect(Value.Check(tool.parameters, { cursor: "x".repeat(65_537) })).toBe(false);
    for (const forged of [
      { workspaceDir: "C:\\forged" },
      { accessToken: "access-token-CANARY" },
      { signedUrl: "https://cdn.example.test/signed-CANARY" },
      { unknown: true },
    ]) {
      expect(Value.Check(tool.parameters, forged)).toBe(false);
    }
  });

  it("accepts exactly one download identity and rejects undeclared fields", () => {
    const tool = requiredReadTool(
      captureReadTools(inertReadOrchestrator()),
      "pan_sync_download",
    );

    expect(Value.Check(tool.parameters, { fileId: "file-1" })).toBe(true);
    expect(Value.Check(tool.parameters, { remotePath: "/report.pdf" })).toBe(true);
    expect(Value.Check(tool.parameters, {})).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        fileId: "file-1",
        remotePath: "/report.pdf",
      }),
    ).toBe(false);
    expect(Value.Check(tool.parameters, { fileId: "" })).toBe(false);
    for (const forged of [
      { fileId: "file-1", workspaceDir: "C:\\forged" },
      { fileId: "file-1", accessToken: "access-token-CANARY" },
      { fileId: "file-1", signedUrl: "https://cdn.example.test/signed-CANARY" },
      { fileId: "file-1", unknown: true },
    ]) {
      expect(Value.Check(tool.parameters, forged)).toBe(false);
    }
  });

  it("projects list results into the approved DTO without runtime canaries", async () => {
    const safeResult: PanSyncListResult = {
      provider: "aliyun",
      remoteDirectory: "/reports",
      query: "quarterly",
      entries: [{
        fileId: "safe-file-1",
        name: "quarterly.pdf",
        type: "file",
        size: 42,
        updatedAt: "2026-08-02T00:00:00.000Z",
        remotePath: "/reports/quarterly.pdf",
      }],
      nextCursor: "safe-cursor",
    };
    const runtimeResult = {
      ...safeResult,
      accessToken: "access-token-CANARY",
      signedUrl: "https://cdn.example.test/signed-CANARY",
      driveId: "drive-CANARY",
      rawResponse: { secret: "raw-response-CANARY" },
      entries: safeResult.entries.map((entry) => ({
        ...entry,
        providerState: { signedUrl: "https://cdn.example.test/signed-CANARY" },
      })),
    } as unknown as PanSyncListResult;
    let receivedInput: unknown;
    const tool = requiredReadTool(
      captureReadTools({
        list: vi.fn(async (input) => {
          receivedInput = input;
          return runtimeResult;
        }),
        download: vi.fn(async () => {
          throw new Error("not executed");
        }),
      }),
      "pan_sync_list",
    );

    const result = await tool.execute("list-1", {
      provider: "aliyun",
      remoteDirectory: "/reports",
      query: "quarterly",
      limit: 10,
    });

    expect(receivedInput).toEqual({
      provider: "aliyun",
      remoteDirectory: "/reports",
      query: "quarterly",
      limit: 10,
    });
    expect(result.details).toEqual(safeResult);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("projects downloaded and confirmation results without absolute paths or runtime canaries", async () => {
    const workspaceDir = "C:\\private\\openclaw\\workspace";
    const downloaded: PanSyncDownloadResult = {
      provider: "aliyun",
      remoteName: "report.pdf",
      localPath: "downloads/report.pdf",
      size: 42,
      status: "downloaded",
    };
    const confirmation: PanSyncDownloadResult = {
      provider: "aliyun",
      remoteName: "large.bin",
      fileId: "safe-file-large",
      size: 104_857_601,
      status: "confirmation_required",
      code: "DOWNLOAD_CONFIRMATION_REQUIRED",
    };
    let nextResult: PanSyncDownloadResult = {
      ...downloaded,
      absolutePath: `${workspaceDir}\\downloads\\report.pdf`,
      signedUrl: "https://cdn.example.test/signed-CANARY",
      driveId: "drive-CANARY",
      rawResponse: { accessToken: "access-token-CANARY" },
    } as unknown as PanSyncDownloadResult;
    const tool = requiredReadTool(
      captureReadTools({
        list: vi.fn(async () => {
          throw new Error("not executed");
        }),
        download: vi.fn(async () => nextResult),
      }, workspaceDir),
      "pan_sync_download",
    );

    const downloadedResult = await tool.execute("download-1", { fileId: "file-1" });
    expect(downloadedResult.details).toEqual(downloaded);
    expect(JSON.stringify(downloadedResult)).not.toContain(workspaceDir);
    expect(JSON.stringify(downloadedResult)).not.toContain("CANARY");

    nextResult = {
      ...confirmation,
      accessToken: "access-token-CANARY",
      signedUrl: "https://cdn.example.test/signed-CANARY",
      absolutePath: `${workspaceDir}\\large.bin`,
    } as unknown as PanSyncDownloadResult;
    const confirmationResult = await tool.execute("download-2", {
      fileId: "safe-file-large",
    });
    expect(confirmationResult.details).toEqual(confirmation);
    expect(JSON.stringify(confirmationResult)).not.toContain(workspaceDir);
    expect(JSON.stringify(confirmationResult)).not.toContain("CANARY");
  });

  it("keeps listing available but rejects downloading without workspace authority", async () => {
    let downloadCalled = false;
    const tools = captureReadTools({
      list: vi.fn(async () => ({
        provider: "aliyun" as const,
        remoteDirectory: "/",
        entries: [],
      })),
      download: vi.fn(async () => {
        downloadCalled = true;
        throw new Error("must not execute");
      }),
    });

    const listResult = await requiredReadTool(tools, "pan_sync_list").execute(
      "list-no-workspace",
      {},
    );
    const downloadResult = await requiredReadTool(
      tools,
      "pan_sync_download",
    ).execute("download-no-workspace", { fileId: "file-1" });

    expect(listResult.details).toEqual({
      provider: "aliyun",
      remoteDirectory: "/",
      entries: [],
    });
    expect(downloadCalled).toBe(false);
    expect(downloadResult.details).toEqual({ code: "WORKSPACE_PATH_REJECTED" });
  });

  it("uses operation-specific fallback errors while preserving stable domain errors", async () => {
    const workspaceDir = "C:\\private\\openclaw\\workspace";
    const unknownFailure = captureReadTools({
      list: vi.fn(async () => {
        throw new Error(`raw list failure access-token-CANARY ${workspaceDir}`);
      }),
      download: vi.fn(async () => {
        throw new Error(`raw download failure signed-url-CANARY ${workspaceDir}`);
      }),
    }, workspaceDir);

    expect(
      (await requiredReadTool(unknownFailure, "pan_sync_list").execute("list-error", {})).details,
    ).toEqual({ code: "REMOTE_DIRECTORY_FAILED" });
    expect(
      (await requiredReadTool(unknownFailure, "pan_sync_download").execute(
        "download-error",
        { fileId: "file-1" },
      )).details,
    ).toEqual({ code: "DOWNLOAD_FAILED" });

    const domainFailure = captureReadTools({
      list: vi.fn(async () => {
        throw new PanSyncError("CREDENTIALS_REQUIRED");
      }),
      download: vi.fn(async () => {
        throw new PanSyncError("REMOTE_ENTRY_NOT_FILE");
      }),
    }, workspaceDir);
    expect(
      (await requiredReadTool(domainFailure, "pan_sync_list").execute("list-domain", {})).details,
    ).toEqual({ code: "CREDENTIALS_REQUIRED" });
    expect(
      (await requiredReadTool(domainFailure, "pan_sync_download").execute(
        "download-domain",
        { fileId: "folder-1" },
      )).details,
    ).toEqual({ code: "REMOTE_ENTRY_NOT_FILE" });
  });
});

describe("OpenClaw manifest ownership", () => {
  it("resolves the CLI only through the public openclaw/cli-entry export", () => {
    const requestedSpecifiers: string[] = [];
    const cliEntry = resolveOpenClawCliEntry((specifier) => {
      requestedSpecifiers.push(specifier);
      if (specifier !== "openclaw/cli-entry") {
        throw new Error(`unexpected private resolution: ${specifier}`);
      }
      return "C:\\public-export\\openclaw-cli.mjs";
    });

    expect(cliEntry).toBe("C:\\public-export\\openclaw-cli.mjs");
    expect(requestedSpecifiers).toEqual(["openclaw/cli-entry"]);
  });

  it(
    "loads all three declared Tool contracts through the installed OpenClaw registry",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pan-sync-tool-manifest-"));
      const pluginDir = join(root, "plugin");
      const stateDir = join(root, "state");
      await mkdir(pluginDir);
      await mkdir(stateDir);

      try {
        const manifest = await readFile(
          new URL("../../openclaw.plugin.json", import.meta.url),
          "utf8",
        );
        await writeFile(
          join(pluginDir, "package.json"),
          JSON.stringify(
            {
              name: "openclaw-plugin-sheen-pansync",
              version: "0.1.0",
              type: "module",
              openclaw: { extensions: ["./index.js"] },
            },
            null,
            2,
          ),
          "utf8",
        );
        await writeFile(join(pluginDir, "openclaw.plugin.json"), manifest, "utf8");
        await writeFile(
          join(pluginDir, "index.js"),
          `export default {
  id: "sheen-pansync",
  name: "Sheen PanSync",
  register(api) {
    for (const name of ["pan_sync_upload", "pan_sync_list", "pan_sync_download"]) {
      api.registerTool(
        () => ({
          name,
          label: name,
          description: "Manifest ownership probe",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() { return { content: [], details: {} }; },
        }),
        { name },
      );
    }
  },
};
`,
          "utf8",
        );

        const install = await withOpenClawInstallLease(() =>
          runOpenClaw(["plugins", "install", "-l", pluginDir], stateDir)
        );
        expect(install.error).toBeUndefined();
        expect(install.status, install.stderr).toBe(0);

        const inspect = runOpenClaw(
          ["plugins", "inspect", "sheen-pansync", "--runtime", "--json"],
          stateDir,
        );
        expect(inspect.error).toBeUndefined();
        expect(inspect.status, inspect.stderr).toBe(0);
        expect(
          inspect.stdout.trim(),
          JSON.stringify({ stderr: inspect.stderr, status: inspect.status }),
        ).not.toBe("");
        const result = JSON.parse(inspect.stdout) as {
          tools?: Array<{ names?: string[] }>;
          diagnostics?: Array<{ message?: string }>;
          plugin?: { toolNames?: string[] };
        };
        expect(
          result.diagnostics?.filter(({ message }) =>
            message?.includes("contracts.tools"),
          ),
        ).toEqual([]);
        const declaredTools = [
          "pan_sync_upload",
          "pan_sync_list",
          "pan_sync_download",
        ];
        expect(result.plugin?.toolNames).toEqual(
          expect.arrayContaining(declaredTools),
        );
        expect(result.tools?.flatMap(({ names }) => names ?? [])).toEqual(
          expect.arrayContaining(declaredTools),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    360_000,
  );
});

describe("pan-sync-upload Skill discovery contract", () => {
  function section(contents: string, heading: string): string {
    const start = contents.indexOf(`## ${heading}`);
    expect(start, `missing Skill section: ${heading}`).toBeGreaterThanOrEqual(0);
    const bodyStart = contents.indexOf("\n", start);
    const next = contents.indexOf("\n## ", bodyStart + 1);
    return contents.slice(bodyStart + 1, next === -1 ? undefined : next);
  }

  it("discovers bilingual upload, list, search, download, and read intent", async () => {
    const contents = await readFile(
      new URL("../../skills/pan-sync-upload/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(contents).toMatch(
      /^---\nname: pan-sync-upload\ndescription: .*Chinese or English\.\n---\n/u,
    );
    expect(contents).toMatch(/阿里网盘|阿里云盘/u);
    expect(contents).toMatch(/aliyun|alipan/iu);
    const upload = section(contents, "Upload / 上传");
    const list = section(contents, "List and search / 列出与搜索");
    const download = section(contents, "Download and read / 下载与读取");

    expect(upload).toContain("pan_sync_upload");
    expect(upload).toMatch(/上传/u);
    expect(upload).toMatch(/推送/u);
    expect(upload).toMatch(/传到/u);
    expect(upload).toMatch(/保存到/u);
    expect(upload).toMatch(/upload/iu);
    expect(upload).toMatch(/push/iu);
    expect(upload).toMatch(/send[^\n]*to/iu);
    expect(upload).toMatch(/save[^\n]*to/iu);

    expect(list).toContain("pan_sync_list");
    expect(list).toMatch(/列出/u);
    expect(list).toMatch(/查看/u);
    expect(list).toMatch(/浏览/u);
    expect(list).toMatch(/查找/u);
    expect(list).toMatch(/搜索/u);
    expect(list).toMatch(/list/iu);
    expect(list).toMatch(/browse/iu);
    expect(list).toMatch(/find/iu);
    expect(list).toMatch(/search/iu);

    expect(download).toContain("pan_sync_download");
    expect(download).toMatch(/读取/u);
    expect(download).toMatch(/打开/u);
    expect(download).toMatch(/下载/u);
    expect(download).toMatch(/获取/u);
    expect(download).toMatch(/从网盘取出/u);
    expect(download).toMatch(/read/iu);
    expect(download).toMatch(/open/iu);
    expect(download).toMatch(/download/iu);
    expect(download).toMatch(/fetch/iu);
    expect(download).toMatch(/get[^\n]*from/iu);
  });

  it("requires safe clarification, confirmation, and no-tool behavior", async () => {
    const contents = await readFile(
      new URL("../../skills/pan-sync-upload/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(contents).toMatch(/同步网盘[\s\S]*澄清|澄清[\s\S]*同步网盘/u);
    expect(contents).toMatch(/sync cloud drive[\s\S]*clarif|clarif[\s\S]*sync cloud drive/iu);
    expect(contents).toMatch(/多个|multiple/iu);
    expect(contents).toMatch(/选择|select/iu);
    expect(contents).toContain("DOWNLOAD_CONFIRMATION_REQUIRED");
    expect(contents).toMatch(/100 MiB/iu);
    expect(contents).toMatch(/确认|confirm/iu);
    expect(contents).toMatch(/讨论[\s\S]*不调用|不调用[\s\S]*讨论/u);
    expect(contents).toMatch(
      /discuss[\s\S]*(?:do not|must not) call|(?:do not|must not) call[\s\S]*discuss/iu,
    );
    expect(contents).toContain("CREDENTIALS_REQUIRED");
    expect(contents).toContain("Sheen PanSync");
    expect(contents).toContain("openclaw pan-sync configure");
    expect(contents).toContain("OpenList");
    expect(contents).toContain("refresh token");
    expect(contents).toContain("api.oplist.org.cn");
    expect(contents).toContain("directly to Aliyun");
    expect(contents).not.toMatch(/client[ _-]?(?:id|secret)/iu);
  });

  it("requires serialized transfers, root-default downloads, and no tight retries", async () => {
    const contents = await readFile(
      new URL("../../skills/pan-sync-upload/SKILL.md", import.meta.url),
      "utf8",
    );
    const download = section(contents, "Download and read / 下载与读取");
    const upload = section(contents, "Upload / 上传");

    expect(download).toMatch(/did not explicitly specify[\s\S]*omit `localDirectory`/iu);
    expect(download).toMatch(/never derive `localDirectory`[\s\S]*remotePath/iu);
    expect(download).toMatch(/one at a time[\s\S]*pan_sync_download|pan_sync_download[\s\S]*one at a time/iu);
    expect(download).toMatch(/await[\s\S]*before starting the next/iu);
    expect(download).toMatch(/never[\s\S]*concurrent/iu);
    expect(upload).toMatch(/combine[\s\S]*paths[\s\S]*one `pan_sync_upload`/iu);
    expect(upload).toMatch(/never[\s\S]*concurrent[\s\S]*pan_sync_upload/iu);
    expect(upload).toMatch(/await[\s\S]*before starting another/iu);
    for (const code of ["RATE_LIMITED", "DOWNLOAD_FAILED", "UPLOAD_FAILED"]) {
      expect(download).toContain(code);
    }
    expect(download).toMatch(/do not immediately retry|no tight retry loop/iu);
    expect(download).toMatch(/continue the remaining planned files/iu);
  });
});
