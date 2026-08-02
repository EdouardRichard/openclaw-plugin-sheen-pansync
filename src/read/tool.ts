import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import type {
  PanSyncDownloadResult,
  PanSyncListResult,
} from "../contracts.js";
import { safeErrorDetails } from "../errors.js";
import type { ReadOrchestrator } from "./orchestrator.js";

const PanSyncListSchema = Type.Object(
  {
    provider: Type.Optional(Type.Literal("aliyun")),
    remoteDirectory: Type.Optional(Type.String({ minLength: 1 })),
    query: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
  },
  { additionalProperties: false },
);

const DownloadCommonProperties = {
  provider: Type.Optional(Type.Literal("aliyun")),
  localDirectory: Type.Optional(Type.String({ minLength: 1 })),
  confirmedLargeDownload: Type.Optional(Type.Boolean()),
};

const PanSyncDownloadSchema = Type.Union([
  Type.Object(
    {
      provider: DownloadCommonProperties.provider,
      fileId: Type.String({ minLength: 1 }),
      localDirectory: DownloadCommonProperties.localDirectory,
      confirmedLargeDownload: DownloadCommonProperties.confirmedLargeDownload,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      provider: DownloadCommonProperties.provider,
      remotePath: Type.String({ minLength: 1 }),
      localDirectory: DownloadCommonProperties.localDirectory,
      confirmedLargeDownload: DownloadCommonProperties.confirmedLargeDownload,
    },
    { additionalProperties: false },
  ),
]);

type PanSyncListParameters = Static<typeof PanSyncListSchema>;
type PanSyncDownloadParameters = Static<typeof PanSyncDownloadSchema>;

type PanSyncReadToolContext = {
  workspaceDir?: string;
};

function projectSafeListResult(result: PanSyncListResult): PanSyncListResult {
  return {
    provider: result.provider,
    remoteDirectory: result.remoteDirectory,
    ...(result.query === undefined ? {} : { query: result.query }),
    entries: result.entries.map((entry) => ({
      fileId: entry.fileId,
      name: entry.name,
      type: entry.type,
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
      ...(entry.remotePath === undefined ? {} : { remotePath: entry.remotePath }),
    })),
    ...(result.nextCursor === undefined
      ? {}
      : { nextCursor: result.nextCursor }),
  };
}

function projectSafeDownloadResult(
  result: PanSyncDownloadResult,
): PanSyncDownloadResult {
  if (result.status === "confirmation_required") {
    return {
      provider: result.provider,
      remoteName: result.remoteName,
      fileId: result.fileId,
      size: result.size,
      status: "confirmation_required",
      code: "DOWNLOAD_CONFIRMATION_REQUIRED",
    };
  }
  return {
    provider: result.provider,
    remoteName: result.remoteName,
    localPath: result.localPath,
    size: result.size,
    status: "downloaded",
  };
}

function createPanSyncListTool(
  orchestrator: Pick<ReadOrchestrator, "list">,
) {
  return {
    name: "pan_sync_list" as const,
    label: "Pan Sync List",
    description: "List a resource-drive directory or search file names within its bounded subtree.",
    parameters: PanSyncListSchema,
    async execute(
      _toolCallId: string,
      params: PanSyncListParameters,
    ) {
      try {
        return jsonResult(projectSafeListResult(await orchestrator.list(params)));
      } catch (error) {
        return jsonResult(safeErrorDetails(error, "REMOTE_DIRECTORY_FAILED"));
      }
    },
  };
}

function createPanSyncDownloadTool(
  context: PanSyncReadToolContext,
  orchestrator: Pick<ReadOrchestrator, "download">,
) {
  return {
    name: "pan_sync_download" as const,
    label: "Pan Sync Download",
    description: "Download one concrete resource-drive file into the current OpenClaw workspace without overwriting an existing file.",
    parameters: PanSyncDownloadSchema,
    async execute(
      _toolCallId: string,
      params: PanSyncDownloadParameters,
    ) {
      if (!context.workspaceDir) {
        return jsonResult({ code: "WORKSPACE_PATH_REJECTED" as const });
      }
      try {
        return jsonResult(projectSafeDownloadResult(await orchestrator.download({
          ...params,
          workspaceDir: context.workspaceDir,
        })));
      } catch (error) {
        return jsonResult(safeErrorDetails(error, "DOWNLOAD_FAILED"));
      }
    },
  };
}

type PanSyncReadTool =
  | ReturnType<typeof createPanSyncListTool>
  | ReturnType<typeof createPanSyncDownloadTool>;

export type PanSyncReadToolApi = {
  registerTool(
    factory: (context: PanSyncReadToolContext) => PanSyncReadTool,
    options?: { name?: string },
  ): void;
};

export function registerPanSyncReadTools(
  api: PanSyncReadToolApi,
  orchestrator: Pick<ReadOrchestrator, "list" | "download">,
): void {
  api.registerTool(
    () => createPanSyncListTool(orchestrator),
    { name: "pan_sync_list" },
  );
  api.registerTool(
    (context) => createPanSyncDownloadTool(context, orchestrator),
    { name: "pan_sync_download" },
  );
}
