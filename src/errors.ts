export type PanSyncErrorCode =
  | "CREDENTIALS_REQUIRED"
  | "CREDENTIALS_INVALID"
  | "RESOURCE_DRIVE_UNAVAILABLE"
  | "REFRESH_TOKEN_REJECTED"
  | "AUTHORIZATION_REVOKED"
  | "TOKEN_ENDPOINT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "WORKSPACE_PATH_REJECTED"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_READABLE"
  | "REMOTE_DIRECTORY_FAILED"
  | "REMOTE_FILE_NOT_FOUND"
  | "REMOTE_FILE_AMBIGUOUS"
  | "REMOTE_ENTRY_NOT_FILE"
  | "DOWNLOAD_CONFIRMATION_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "DOWNLOAD_FAILED"
  | "UPLOAD_FAILED"
  | "UPLOAD_PARTIAL";

export class PanSyncError extends Error {
  readonly code: PanSyncErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: PanSyncErrorCode, options: { retryAfterMs?: number } = {}) {
    super(code);
    this.name = "PanSyncError";
    this.code = code;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export function safeErrorDetails(
  error: unknown,
  fallback: PanSyncErrorCode = "UPLOAD_FAILED",
): { code: PanSyncErrorCode } {
  if (error instanceof PanSyncError) {
    return { code: error.code };
  }

  return { code: fallback };
}
