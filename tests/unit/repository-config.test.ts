import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import vitestConfig from "../../vitest.config.js";

const attributesPath = new URL("../../.gitattributes", import.meta.url);

describe("repository configuration", () => {
  it("keeps Vitest defaults while excluding repository-local worktrees", () => {
    expect(vitestConfig.test?.exclude).toEqual(
      expect.arrayContaining([
        ...configDefaults.exclude,
        "**/.worktrees/**",
        "**/worktrees/**",
      ]),
    );
  });

  it("keeps bundled Skill files on LF across Git checkouts", () => {
    const attributes = existsSync(attributesPath) ? readFileSync(attributesPath, "utf8") : "";
    const rules = attributes
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(rules).toContain("skills/**/SKILL.md text eol=lf");
  });
});
