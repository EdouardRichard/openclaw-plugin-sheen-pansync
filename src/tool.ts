import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import { safeErrorDetails } from "./errors.js";
import type { UploadOrchestrator } from "./upload/orchestrator.js";

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
          await orchestrator.upload({
            ...params,
            workspaceDir: context.workspaceDir,
          }),
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
