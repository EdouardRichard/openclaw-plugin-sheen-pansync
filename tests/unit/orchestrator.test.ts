import type { FileHandle } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  CloudDriveProvider,
  ProviderUploadInput,
  ProviderUploadResult,
  RemoteDirectory,
} from "../../src/contracts.js";
import { PanSyncError } from "../../src/errors.js";
import {
  UploadOrchestrator,
  type UploadOrchestratorDependencies,
} from "../../src/upload/orchestrator.js";
import type { ResolvedWorkspaceFile } from "../../src/workspace/path-guard.js";

type HarnessOptions = {
  defaultDirectory?: string;
  identities?: Readonly<Record<string, string>>;
  resolutionFailures?: Readonly<Record<string, unknown>>;
  tokenFailure?: unknown;
  directoryFailure?: unknown;
  upload?: (
    input: ProviderUploadInput,
    call: number,
  ) => Promise<ProviderUploadResult>;
};

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const opened: Array<{
    input: string;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const identityByFile = new WeakMap<ResolvedWorkspaceFile, string>();
  let uploadCall = 0;

  const provider: CloudDriveProvider = {
    id: "aliyun",
    aliases: ["aliyun"],
    async validateCredentials() {
      throw new Error("validateCredentials must not be called by uploads");
    },
    async ensureDirectory(
      remotePath: string,
      accessToken: string,
    ): Promise<RemoteDirectory> {
      events.push(`ensure:${remotePath}:${accessToken}`);
      if (options.directoryFailure !== undefined) {
        throw options.directoryFailure;
      }
      return {
        id: "remote-directory",
        path: remotePath,
        providerState: {},
      };
    },
    async uploadFile(
      input: ProviderUploadInput,
    ): Promise<ProviderUploadResult> {
      uploadCall += 1;
      events.push(`upload:${input.file.inputName}`);
      if (options.upload !== undefined) {
        return options.upload(input, uploadCall);
      }
      return {
        remoteName: input.file.basename,
        size: input.file.size,
      };
    },
  };

  const dependencies: UploadOrchestratorDependencies = {
    providerRegistry: {
      resolve(providerName) {
        events.push(`provider:${providerName ?? "default"}`);
        return provider;
      },
    },
    tokenManager: {
      async getValidAccessToken() {
        events.push("token");
        if (options.tokenFailure !== undefined) {
          throw options.tokenFailure;
        }
        return "access-token";
      },
    },
    config: {
      defaultDirectory: options.defaultDirectory ?? "/openClawShare",
    },
    pathGuard: {
      async resolveWorkspaceFile(_workspaceDir, input) {
        events.push(`resolve:${input}`);
        const resolutionFailure = options.resolutionFailures?.[input];
        if (resolutionFailure !== undefined) {
          throw resolutionFailure;
        }
        const close = vi.fn(async () => {
          events.push(`close:${input}`);
        });
        const file: ResolvedWorkspaceFile = {
          inputName: input,
          basename: input,
          size: 1,
          handle: { close } as unknown as FileHandle,
        };
        identityByFile.set(file, options.identities?.[input] ?? input);
        opened.push({ input, close });
        return file;
      },
      isSameWorkspaceFile(left, right) {
        return identityByFile.get(left) === identityByFile.get(right);
      },
    },
  };

  return {
    orchestrator: new UploadOrchestrator(dependencies),
    events,
    opened,
  };
}

describe("UploadOrchestrator", () => {
  it("uploads files sequentially with the default provider and directory", async () => {
    const { orchestrator, events, opened } = harness({
      upload: async (input, call) => ({
        remoteName: call === 2 ? "b (1).txt" : input.file.basename,
        size: input.file.size,
      }),
    });

    await expect(
      orchestrator.upload({
        workspaceDir: "workspace",
        paths: ["a.txt", "b.txt"],
      }),
    ).resolves.toEqual({
      provider: "aliyun",
      remoteDirectory: "/openClawShare",
      status: "success",
      files: [
        {
          inputName: "a.txt",
          remoteName: "a.txt",
          size: 1,
          status: "uploaded",
        },
        {
          inputName: "b.txt",
          remoteName: "b (1).txt",
          size: 1,
          status: "uploaded",
        },
      ],
    });
    expect(events).toEqual([
      "provider:default",
      "token",
      "ensure:/openClawShare:access-token",
      "resolve:a.txt",
      "upload:a.txt",
      "close:a.txt",
      "resolve:b.txt",
      "upload:b.txt",
      "close:b.txt",
    ]);
    expect(opened.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
  });

  it("returns a partial result with only the stable code for a failed file", async () => {
    const { orchestrator, opened } = harness({
      upload: async (input, call) => {
        if (call === 2) {
          throw new PanSyncError("QUOTA_EXCEEDED");
        }
        return {
          remoteName: input.file.basename,
          size: input.file.size,
        };
      },
    });

    await expect(
      orchestrator.upload({
        workspaceDir: "workspace",
        paths: ["a.txt", "b.txt"],
      }),
    ).resolves.toEqual({
      provider: "aliyun",
      remoteDirectory: "/openClawShare",
      status: "partial",
      files: [
        {
          inputName: "a.txt",
          remoteName: "a.txt",
          size: 1,
          status: "uploaded",
        },
        {
          inputName: "b.txt",
          status: "failed",
          errorCode: "QUOTA_EXCEEDED",
        },
      ],
    });
    expect(opened.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
  });

  it("continues after a per-file failure and maps unknown details to UPLOAD_FAILED", async () => {
    const { orchestrator, events } = harness({
      upload: async (input, call) => {
        if (call === 2) {
          throw new Error("raw provider body with secret-token");
        }
        return {
          remoteName: input.file.basename,
          size: input.file.size,
        };
      },
    });

    const result = await orchestrator.upload({
      workspaceDir: "workspace",
      paths: ["a.txt", "b.txt", "c.txt"],
    });

    expect(result.status).toBe("partial");
    expect(result.files).toEqual([
      {
        inputName: "a.txt",
        remoteName: "a.txt",
        size: 1,
        status: "uploaded",
      },
      {
        inputName: "b.txt",
        status: "failed",
        errorCode: "UPLOAD_FAILED",
      },
      {
        inputName: "c.txt",
        remoteName: "c.txt",
        size: 1,
        status: "uploaded",
      },
    ]);
    expect(events).toContain("upload:c.txt");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it.each([
    { paths: [] },
    {
      paths: Array.from({ length: 101 }, (_, index) => `${index}.txt`),
    },
  ])(
    "rejects path counts outside the 1..100 boundary",
    async ({ paths }) => {
      const { orchestrator, events } = harness();

      await expect(
        orchestrator.upload({ workspaceDir: "workspace", paths }),
      ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
      expect(events).toEqual([]);
    },
  );

  it("accepts exactly 100 paths", async () => {
    const { orchestrator, opened } = harness();
    const paths = Array.from({ length: 100 }, (_, index) => `${index}.txt`);

    const result = await orchestrator.upload({
      workspaceDir: "workspace",
      paths,
    });

    expect(result.status).toBe("success");
    expect(result.files).toHaveLength(100);
    expect(opened).toHaveLength(100);
    expect(opened.every(({ close }) => close.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("deduplicates the same opened-file identity and closes the duplicate", async () => {
    const { orchestrator, events, opened } = harness({
      identities: {
        "report.txt": "device-1:file-20",
        "alias.txt": "device-1:file-20",
      },
    });

    await expect(
      orchestrator.upload({
        workspaceDir: "workspace",
        paths: ["report.txt", "alias.txt"],
      }),
    ).resolves.toMatchObject({
      status: "success",
      files: [
        {
          inputName: "report.txt",
          status: "uploaded",
        },
      ],
    });
    expect(events.filter((event) => event.startsWith("upload:"))).toEqual([
      "upload:report.txt",
    ]);
    expect(opened.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
  });

  it("keeps credentials-required as a global precondition failure", async () => {
    const { orchestrator, events } = harness({
      tokenFailure: new PanSyncError("CREDENTIALS_REQUIRED"),
    });

    await expect(
      orchestrator.upload({
        workspaceDir: "workspace",
        paths: ["a.txt"],
      }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_REQUIRED" });
    expect(events).toEqual(["provider:default", "token"]);
  });

  it("normalizes an explicit directory before ensuring it exactly once", async () => {
    const { orchestrator, events } = harness();

    const result = await orchestrator.upload({
      workspaceDir: "workspace",
      paths: ["a.txt", "b.txt"],
      provider: "aliyun",
      remoteDirectory: "///reports//daily",
    });

    expect(result.remoteDirectory).toBe("/reports/daily");
    expect(events.filter((event) => event.startsWith("provider:"))).toEqual([
      "provider:aliyun",
    ]);
    expect(events.filter((event) => event.startsWith("ensure:"))).toEqual([
      "ensure:/reports/daily:access-token",
    ]);
  });

  it("normalizes the configured default directory", async () => {
    const { orchestrator, events } = harness({
      defaultDirectory: "reports/./daily",
    });

    const result = await orchestrator.upload({
      workspaceDir: "workspace",
      paths: ["a.txt"],
    });

    expect(result.remoteDirectory).toBe("/reports/daily");
    expect(events).toContain("ensure:/reports/daily:access-token");
  });

  it("does not open files when directory setup fails globally", async () => {
    const { orchestrator, events, opened } = harness({
      directoryFailure: new PanSyncError("REMOTE_DIRECTORY_FAILED"),
    });

    await expect(
      orchestrator.upload({
        workspaceDir: "workspace",
        paths: ["a.txt"],
      }),
    ).rejects.toMatchObject({ code: "REMOTE_DIRECTORY_FAILED" });
    expect(events).toEqual([
      "provider:default",
      "token",
      "ensure:/openClawShare:access-token",
    ]);
    expect(opened).toEqual([]);
  });

  it("keeps path failures per-file, closes acquired handles, and aggregates failed", async () => {
    const { orchestrator, events, opened } = harness({
      resolutionFailures: {
        "missing.txt": new PanSyncError("FILE_NOT_FOUND"),
        "unreadable.txt": new PanSyncError("FILE_NOT_READABLE"),
      },
    });

    const result = await orchestrator.upload({
      workspaceDir: "workspace",
      paths: ["missing.txt", "ok.txt", "unreadable.txt"],
    });

    expect(result).toMatchObject({
      status: "partial",
      files: [
        {
          inputName: "missing.txt",
          status: "failed",
          errorCode: "FILE_NOT_FOUND",
        },
        {
          inputName: "ok.txt",
          status: "uploaded",
        },
        {
          inputName: "unreadable.txt",
          status: "failed",
          errorCode: "FILE_NOT_READABLE",
        },
      ],
    });
    expect(events).toContain("upload:ok.txt");
    expect(opened.map(({ close }) => close.mock.calls.length)).toEqual([1]);

    const allFailed = await harness({
      resolutionFailures: {
        "missing.txt": new PanSyncError("FILE_NOT_FOUND"),
      },
    }).orchestrator.upload({
      workspaceDir: "workspace",
      paths: ["missing.txt"],
    });
    expect(allFailed.status).toBe("failed");
  });
});
