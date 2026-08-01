export type PanSyncErrorCode =
  | "CREDENTIALS_REQUIRED"
  | "CREDENTIALS_INVALID"
  | "REFRESH_TOKEN_REJECTED"
  | "AUTHORIZATION_REVOKED"
  | "TOKEN_ENDPOINT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "WORKSPACE_PATH_REJECTED"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_READABLE"
  | "REMOTE_DIRECTORY_FAILED"
  | "QUOTA_EXCEEDED"
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

export function safeErrorDetails(error: unknown): { code: PanSyncErrorCode } {
  if (error instanceof PanSyncError) {
    return { code: error.code };
  }

  return { code: "UPLOAD_FAILED" };
}
