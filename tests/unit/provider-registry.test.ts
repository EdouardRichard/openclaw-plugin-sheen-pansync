import { describe, expect, it } from "vitest";
import { PanSyncError } from "../../src/errors.js";
import { ProviderRegistry } from "../../src/provider-registry.js";

const aliyun = {
  id: "aliyun",
  aliases: ["阿里网盘", "阿里云盘", "aliyun", "alipan"],
} as const;

describe("ProviderRegistry", () => {
  it.each(["阿里网盘", "阿里云盘", "aliyun", "ALIPAN"])(
    "resolves %s to aliyun",
    (name) => {
      const registry = new ProviderRegistry([aliyun as never], "aliyun");

      expect(registry.resolve(name).id).toBe("aliyun");
    },
  );

  it("uses aliyun when provider is omitted", () => {
    const registry = new ProviderRegistry([aliyun as never], "aliyun");

    expect(registry.resolve(undefined).id).toBe("aliyun");
  });

  it("rejects aliases that collide after English normalization", () => {
    expect(
      () =>
        new ProviderRegistry(
          [{ ...aliyun, aliases: ["aliyun", "ALIYUN"] } as never],
          "aliyun",
        ),
    ).toThrow("duplicate provider alias");
  });

  it("returns a stable error for an unknown provider without echoing it", () => {
    const registry = new ProviderRegistry([aliyun as never], "aliyun");
    const rawInput = "private-provider-token";

    try {
      registry.resolve(rawInput);
      throw new Error("expected resolve to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PanSyncError);
      expect((error as PanSyncError).code).toBe("CREDENTIALS_INVALID");
      expect((error as Error).message).not.toContain(rawInput);
    }
  });
});
