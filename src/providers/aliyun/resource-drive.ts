import { PanSyncError } from "../../errors.js";

export type ResourceDriveSummary = {
  driveId: string;
  userId: string;
  displayName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseResourceDriveSummary(body: unknown): ResourceDriveSummary {
  if (!isRecord(body)) throw new PanSyncError("CREDENTIALS_INVALID");
  const driveId = nonEmptyString(body, "resource_drive_id");
  const userId = nonEmptyString(body, "user_id");
  if (driveId === undefined) {
    throw new PanSyncError("RESOURCE_DRIVE_UNAVAILABLE");
  }
  if (userId === undefined) throw new PanSyncError("CREDENTIALS_INVALID");
  const displayName = nonEmptyString(body, "name")
    ?? nonEmptyString(body, "nick_name")
    ?? nonEmptyString(body, "user_name");
  return displayName === undefined
    ? { driveId, userId }
    : { driveId, userId, displayName };
}
