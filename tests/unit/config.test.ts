import { describe, expect, it } from "vitest";
import { resolvePluginConfig } from "../../src/config.js";

describe("resolvePluginConfig", () => {
  it("uses the v1 defaults", () => {
    expect(resolvePluginConfig(undefined)).toEqual({
      defaultDirectory: "/openClawShare",
      tokenGuideUrl: undefined,
    });
  });

  it("rejects credentials in ordinary plugin config", () => {
    expect(() => resolvePluginConfig({ refreshToken: "must-not-live-here" })).toThrow(
      "unknown configuration key",
    );
  });
});
