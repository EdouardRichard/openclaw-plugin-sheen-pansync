import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const releaseGuardPath = fileURLToPath(
  new URL("../../scripts/verify-release-tag.mjs", import.meta.url),
);
const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/npm-publish.yml", import.meta.url),
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version: string;
};
const mismatchedTag =
  packageJson.version === "999.999.999" ? "v999.999.998" : "v999.999.999";

function runReleaseGuard(tag: string) {
  return spawnSync(process.execPath, [releaseGuardPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: tag },
  });
}

describe("npm release workflow", () => {
  it("accepts only the stable Tag that exactly matches package.json", () => {
    const matching = runReleaseGuard(`v${packageJson.version}`);
    expect(matching.status, matching.stderr).toBe(0);

    for (const invalidTag of [
      mismatchedTag,
      `v${packageJson.version}-beta.1`,
      `release-${packageJson.version}`,
    ]) {
      const result = runReleaseGuard(invalidTag);
      expect(result.status, invalidTag).not.toBe(0);
    }
  });

  it("publishes matching Git Tags through least-privilege npm OIDC", () => {
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain('name: Publish to npm');
    expect(workflow).toContain('      - "v*.*.*"');
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain(
      'registry-url: "https://registry.npmjs.org"',
    );
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("node scripts/verify-release-tag.mjs");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).not.toContain("NPM_TOKEN");
  });
});
