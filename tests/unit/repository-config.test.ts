import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import vitestConfig from "../../vitest.config.js";

const attributesPath = new URL("../../.gitattributes", import.meta.url);
const packageJsonPath = new URL("../../package.json", import.meta.url);
const packageLockPath = new URL("../../package-lock.json", import.meta.url);
const licensePath = new URL("../../LICENSE", import.meta.url);

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

  it("publishes Sheen PanSync under the approved MIT package identity", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      license?: string;
      homepage?: string;
      bugs?: { url?: string };
      repository?: { url?: string };
      openclaw?: { install?: { npmSpec?: string } };
    };
    const lockfile = JSON.parse(readFileSync(packageLockPath, "utf8")) as {
      name?: string;
      packages?: Record<string, { name?: string; license?: string }>;
    };

    expect(packageJson.name).toBe("openclaw-plugin-sheen-pansync");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.openclaw?.install?.npmSpec).toBe(
      "openclaw-plugin-sheen-pansync",
    );
    expect(packageJson.homepage).toBe(
      "https://github.com/EdouardRichard/openclaw-plugin-sheen-pansync#readme",
    );
    expect(packageJson.bugs?.url).toBe(
      "https://github.com/EdouardRichard/openclaw-plugin-sheen-pansync/issues",
    );
    expect(packageJson.repository?.url).toBe(
      "git+https://github.com/EdouardRichard/openclaw-plugin-sheen-pansync.git",
    );
    expect(lockfile.name).toBe(packageJson.name);
    expect(lockfile.packages?.[""]?.name).toBe(packageJson.name);
    expect(lockfile.packages?.[""]?.license).toBe("MIT");
    expect(existsSync(licensePath)).toBe(true);

    const license = readFileSync(licensePath, "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 EdouardRichard");
  });
});
