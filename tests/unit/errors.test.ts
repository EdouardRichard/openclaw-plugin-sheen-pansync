import { describe, expect, it } from "vitest";
import { PanSyncError, safeErrorDetails } from "../../src/errors.js";

describe("safeErrorDetails", () => {
  it("does not expose secrets or absolute paths", () => {
    const secret = "refresh-secret-value";
    const error = new Error(`request failed token=${secret} at /srv/openclaw/report.pdf`);

    expect(safeErrorDetails(error)).toEqual({ code: "UPLOAD_FAILED" });
    expect(JSON.stringify(safeErrorDetails(error))).not.toContain(secret);
    expect(JSON.stringify(safeErrorDetails(error))).not.toContain("/srv/openclaw");
  });

  it("keeps explicit stable errors", () => {
    expect(safeErrorDetails(new PanSyncError("QUOTA_EXCEEDED"))).toEqual({
      code: "QUOTA_EXCEEDED",
    });
  });
});
