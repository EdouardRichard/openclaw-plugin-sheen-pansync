import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import type { FileUploadResult, PanSyncUploadResult } from "./contracts.js";
import { safeErrorDetails } from "./errors.js";
import type { UploadOrchestrator } from "./upload/orchestrator.js";
import { normalizeRemoteDirectory } from "./workspace/path-guard.js";

const PanSyncUploadSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 100,
    }),
    provider: Type.Optional(Type.Literal("aliyun")),
    remoteDirectory: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

type PanSyncUploadParameters = Static<typeof PanSyncUploadSchema>;

type PanSyncUploadToolContext = {
  workspaceDir?: string;
};

function projectSafeFileResult(file: FileUploadResult): FileUploadResult {
  return {
    inputName: file.inputName,
    ...(file.remoteName !== undefined
      ? { remoteName: file.remoteName }
      : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    status: file.status,
    ...(file.errorCode !== undefined
      ? { errorCode: file.errorCode }
      : {}),
  };
}

function projectSafeUploadResult(
  result: PanSyncUploadResult,
): PanSyncUploadResult {
  return {
    provider: result.provider,
    remoteDirectory: normalizeRemoteDirectory(result.remoteDirectory),
    status: result.status,
    files: result.files.map(projectSafeFileResult),
  };
}

function createPanSyncUploadTool(
  context: PanSyncUploadToolContext,
  orchestrator: Pick<UploadOrchestrator, "upload">,
) {
  return {
    name: "pan_sync_upload",
    label: "Pan Sync Upload",
    description: "Upload concrete files from the current OpenClaw workspace to a configured cloud drive.",
    parameters: PanSyncUploadSchema,
    async execute(
      _toolCallId: string,
      params: PanSyncUploadParameters,
    ) {
      if (!context.workspaceDir) {
        return jsonResult({ code: "WORKSPACE_PATH_REJECTED" as const });
      }

      try {
        return jsonResult(
          projectSafeUploadResult(
            await orchestrator.upload({
              ...params,
              workspaceDir: context.workspaceDir,
            }),
          ),
        );
      } catch (error) {
        return jsonResult(safeErrorDetails(error));
      }
    },
  };
}

export type PanSyncUploadToolApi = {
  registerTool(
    factory: (
      context: PanSyncUploadToolContext,
    ) => ReturnType<typeof createPanSyncUploadTool>,
    options?: { name?: string },
  ): void;
};

export function registerPanSyncUploadTool(
  api: PanSyncUploadToolApi,
  orchestrator: Pick<UploadOrchestrator, "upload">,
): void {
  api.registerTool(
    (context) => createPanSyncUploadTool(context, orchestrator),
    { name: "pan_sync_upload" },
  );
}
