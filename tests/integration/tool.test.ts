import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { PanSyncUploadResult } from "../../src/contracts.js";
import { PanSyncError } from "../../src/errors.js";
import {
  registerPanSyncUploadTool,
  type PanSyncUploadToolApi,
} from "../../src/tool.js";
import type { UploadOrchestrator } from "../../src/upload/orchestrator.js";

type ToolRegistration = Parameters<PanSyncUploadToolApi["registerTool"]>[0];
type CapturedTool = ReturnType<ToolRegistration>;

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
    timeout: 45_000,
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
    "loads the declared pan_sync_upload contract through the installed OpenClaw registry",
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
              name: "openclaw-pan-sync-helper",
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
  id: "pan-sync-helper",
  name: "Pan Sync Helper",
  register(api) {
    api.registerTool(
      () => ({
        name: "pan_sync_upload",
        label: "Pan Sync Upload",
        description: "Manifest ownership probe",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return { content: [], details: {} }; },
      }),
      { name: "pan_sync_upload" },
    );
  },
};
`,
          "utf8",
        );

        const install = runOpenClaw(["plugins", "install", "-l", pluginDir], stateDir);
        expect(install.error).toBeUndefined();
        expect(install.status, install.stderr).toBe(0);

        const inspect = runOpenClaw(
          ["plugins", "inspect", "pan-sync-helper", "--runtime", "--json"],
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
        expect(result.plugin?.toolNames).toContain("pan_sync_upload");
        expect(result.tools?.flatMap(({ names }) => names ?? [])).toContain(
          "pan_sync_upload",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("pan-sync-upload Skill discovery contract", () => {
  it("declares the approved explicit-trigger and safe-upload guidance", async () => {
    const contents = await readFile(
      new URL("../../skills/pan-sync-upload/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(contents).toMatch(
      /^---\nname: pan-sync-upload\ndescription: Upload concrete OpenClaw workspace files when the user explicitly asks to push, upload, or sync results to a cloud drive\.\n---\n/u,
    );
    expect(contents).toContain("阿里网盘");
    expect(contents).toContain("阿里云盘");
    expect(contents).toContain("aliyun");
    expect(contents).toContain("alipan");
    expect(contents).toMatch(/明确.*上传|上传.*明确/u);
    expect(contents).toMatch(/讨论.*不.*调用/u);
    expect(contents).toMatch(/先.*生成.*确认.*路径.*存在.*再.*调用/u);
    expect(contents).toMatch(/不得.*虚构.*路径/u);
    expect(contents).toMatch(/同一.*规范.*文件.*不得.*重复/u);
    expect(contents).toContain("CREDENTIALS_REQUIRED");
    expect(contents).toContain("Pan Sync Helper");
    expect(contents).toContain("openclaw pan-sync configure");
    expect(contents).toContain("OpenList");
    expect(contents).toContain("refresh token");
    expect(contents).toContain("api.oplist.org.cn");
    expect(contents).toContain("directly to Aliyun");
    expect(contents).not.toMatch(/client[ _-]?(?:id|secret)/iu);
  });
});
