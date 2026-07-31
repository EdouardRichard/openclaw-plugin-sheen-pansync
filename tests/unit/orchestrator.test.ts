import type { FileHandle } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  CloudDriveProvider,
  ProviderUploadInput,
  ProviderUploadResult,
  RemoteDirectory,
} from "../../src/contracts.js";
import { TokenManager } from "../../src/credentials/token-manager.js";
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
  closeFailures?: Readonly<Record<string, unknown>>;
  tokenManager?: UploadOrchestratorDependencies["tokenManager"];
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
    tokenManager: options.tokenManager ?? {
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
          const closeFailure = options.closeFailures?.[input];
          if (closeFailure !== undefined) {
            throw closeFailure;
          }
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
      "resolve:b.txt",
      "upload:a.txt",
      "upload:b.txt",
      "close:a.txt",
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
    expect(events.indexOf("close:alias.txt")).toBeLessThan(
      events.indexOf("upload:report.txt"),
    );
    expect(opened.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
  });

  it.each([
    "CREDENTIALS_REQUIRED",
    "CREDENTIALS_INVALID",
    "REFRESH_TOKEN_REJECTED",
    "AUTHORIZATION_REVOKED",
    "TOKEN_ENDPOINT_UNAVAILABLE",
    "RATE_LIMITED",
  ] as const)(
    "stops remaining uploads and closes every resolved handle on global %s",
    async (code) => {
      const { orchestrator, events, opened } = harness({
        upload: async () => {
          throw new PanSyncError(code);
        },
      });

      await expect(
        orchestrator.upload({
          workspaceDir: "workspace",
          paths: ["a.txt", "b.txt", "c.txt"],
        }),
      ).rejects.toMatchObject({ code });
      expect(events.filter((event) => event.startsWith("upload:"))).toEqual([
        "upload:a.txt",
      ]);
      expect(opened).toHaveLength(3);
      expect(opened.map(({ close }) => close.mock.calls.length)).toEqual([
        1,
        1,
        1,
      ]);
    },
  );

  it.each(["QUOTA_EXCEEDED", "UPLOAD_FAILED"] as const)(
    "continues later unique uploads after file-scoped %s",
    async (code) => {
      const { orchestrator, events, opened } = harness({
        upload: async (input, call) => {
          if (call === 2) {
            throw new PanSyncError(code);
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
      expect(result.files[1]).toEqual({
        inputName: "b.txt",
        status: "failed",
        errorCode: code,
      });
      expect(events.filter((event) => event.startsWith("upload:"))).toEqual([
        "upload:a.txt",
        "upload:b.txt",
        "upload:c.txt",
      ]);
      expect(opened.every(({ close }) => close.mock.calls.length === 1)).toBe(
        true,
      );
    },
  );

  it("finishes all resolution before sequential uploads begin", async () => {
    const resolutionGate = deferred<void>();
    const uploadGates = new Map([
      ["a.txt", deferred<void>()],
      ["b.txt", deferred<void>()],
    ]);
    const events: string[] = [];
    const opened: Array<ReturnType<typeof vi.fn>> = [];
    const identities = new WeakMap<ResolvedWorkspaceFile, string>();
    let activeUploads = 0;
    let maximumActiveUploads = 0;

    const pathGuard: NonNullable<
      UploadOrchestratorDependencies["pathGuard"]
    > = {
      async resolveWorkspaceFile(_workspaceDir, input) {
        events.push(`resolve-start:${input}`);
        if (input === "b.txt") {
          await resolutionGate.promise;
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
        opened.push(close);
        identities.set(file, input);
        events.push(`resolved:${input}`);
        return file;
      },
      isSameWorkspaceFile(left, right) {
        return identities.get(left) === identities.get(right);
      },
    };
    const provider: CloudDriveProvider = {
      id: "aliyun",
      aliases: ["aliyun"],
      async validateCredentials() {
        throw new Error("not used");
      },
      async ensureDirectory(remotePath) {
        return { id: "directory", path: remotePath, providerState: {} };
      },
      async uploadFile(input) {
        activeUploads += 1;
        maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
        events.push(`upload:${input.file.inputName}`);
        await uploadGates.get(input.file.inputName)?.promise;
        activeUploads -= 1;
        return {
          remoteName: input.file.basename,
          size: input.file.size,
        };
      },
    };
    const orchestrator = new UploadOrchestrator({
      providerRegistry: { resolve: () => provider },
      tokenManager: { getValidAccessToken: async () => "access-token" },
      config: { defaultDirectory: "/openClawShare" },
      pathGuard,
    });

    const resultPromise = orchestrator.upload({
      workspaceDir: "workspace",
      paths: ["a.txt", "b.txt"],
    });
    await vi.waitFor(() => {
      expect(events).toContain("resolve-start:b.txt");
    });
    expect(events.some((event) => event.startsWith("upload:"))).toBe(false);

    resolutionGate.resolve();
    await vi.waitFor(() => {
      expect(events).toContain("upload:a.txt");
    });
    expect(events.indexOf("resolved:b.txt")).toBeLessThan(
      events.indexOf("upload:a.txt"),
    );
    expect(events).not.toContain("upload:b.txt");
    uploadGates.get("a.txt")?.resolve();
    await vi.waitFor(() => {
      expect(events).toContain("upload:b.txt");
    });
    expect(maximumActiveUploads).toBe(1);
    uploadGates.get("b.txt")?.resolve();

    await expect(resultPromise).resolves.toMatchObject({ status: "success" });
    expect(maximumActiveUploads).toBe(1);
    expect(opened.map((close) => close.mock.calls.length)).toEqual([1, 1]);
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

  it("propagates CREDENTIALS_REQUIRED from an actual empty TokenManager vault", async () => {
    const refreshToken = vi.fn(async () => {
      throw new Error("refresh must not run without stored credentials");
    });
    const tokenManager = new TokenManager(
      {
        read: async () => undefined,
        replaceIfVersion: async () => false,
      },
      { refreshToken },
    );
    const { orchestrator, events, opened } = harness({ tokenManager });

    await expect(
      orchestrator.upload({
        workspaceDir: "workspace",
        paths: ["a.txt"],
      }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_REQUIRED" });
    expect(refreshToken).not.toHaveBeenCalled();
    expect(events).toEqual(["provider:default"]);
    expect(opened).toEqual([]);
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

  it.each([
    "..",
    ".",
    "",
    "/",
    "../secret.txt",
    "nested/\u0000secret.txt",
    "C:\\private-workspace\\secret.txt",
  ])("uses a neutral failed input name for unsafe path %j", async (input) => {
    const { orchestrator } = harness({
      resolutionFailures: {
        [input]: new PanSyncError("WORKSPACE_PATH_REJECTED"),
      },
    });

    const result = await orchestrator.upload({
      workspaceDir: "D:\\private-workspace",
      paths: [input],
    });

    expect(result.files).toEqual([
      {
        inputName: "invalid-path",
        status: "failed",
        errorCode: "WORKSPACE_PATH_REJECTED",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-workspace");
    expect(JSON.stringify(result)).not.toContain("\\u0000");
  });

  it("suppresses native close failures and still attempts every handle once", async () => {
    const { orchestrator, opened } = harness({
      closeFailures: {
        "a.txt": new Error("native close failure at D:\\private-workspace"),
      },
    });

    const result = await orchestrator.upload({
      workspaceDir: "D:\\private-workspace",
      paths: ["a.txt", "b.txt"],
    });

    expect(result.status).toBe("success");
    expect(opened.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
    expect(JSON.stringify(result)).not.toContain("native close failure");
    expect(JSON.stringify(result)).not.toContain("private-workspace");
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
