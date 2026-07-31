import { readFile } from "node:fs/promises";
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
    let receivedInput: unknown;
    const tool = captureTool(
      {
        upload: vi.fn(async (input) => {
          receivedInput = input;
          return safeResult;
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
  });
});
