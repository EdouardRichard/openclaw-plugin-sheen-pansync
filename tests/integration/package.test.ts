import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type PackResult = Array<{
  files?: Array<{ path?: string }>;
}>;

const temporaryDirectories: string[] = [];
const allowedUiFiles = new Set([
  "ui/setup.html",
  "ui/setup.js",
  "ui/setup.css",
]);
const allowedSkillFiles = new Set([
  "skills/pan-sync-upload/SKILL.md",
]);

function normalizePackagePath(entry: string): string {
  return entry
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function packageViolations(paths: readonly string[]): string[] {
  return paths.flatMap((entry) => {
    const normalized = normalizePackagePath(entry);
    const segments = normalized.split("/");
    const basename = segments.at(-1);
    const rejected = segments.includes("..")
      || segments.includes("tests")
      || segments.includes("plugin-data")
      || basename === ".env"
      || basename === "master.key"
      || basename === "credentials.enc"
      || normalized.startsWith("dist/ui/")
      || normalized.startsWith("dist/skills/")
      || (segments[0] === "ui" && !allowedUiFiles.has(normalized))
      || (segments[0] === "skills" && !allowedSkillFiles.has(normalized));
    return rejected ? [normalized] : [];
  });
}

function runNpm(args: readonly string[]) {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error("npm CLI path unavailable");
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
  });
}

beforeAll(() => {
  const build = runNpm(["run", "build"]);
  expect(build.error).toBeUndefined();
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
}, 60_000);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("published package", () => {
  it("ships the runtime contract without tests or private state", () => {
    const packed = runNpm(["pack", "--json", "--dry-run"]);
    expect(packed.error).toBeUndefined();
    expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);

    const report = JSON.parse(packed.stdout) as PackResult;
    const paths = report[0]?.files?.flatMap(({ path: entry }) =>
      entry === undefined ? [] : [entry.replaceAll("\\", "/")]
    ) ?? [];
    const required = [
      "dist/index.js",
      "dist/admin/cli.js",
      "ui/setup.html",
      "ui/setup.js",
      "ui/setup.css",
      "skills/pan-sync-upload/SKILL.md",
      "openclaw.plugin.json",
      "README.md",
    ];
    for (const entry of required) {
      expect(paths, `missing package entry: ${entry}`).toContain(entry);
    }

    expect(packageViolations(paths)).toEqual([]);
  });

  it("rejects nested private state and undeclared static content", () => {
    const unsafePaths = [
      "ui\\.env",
      "skills/plugin-data/state",
      "dist/tests/helper.js",
      "dist/cache/master.key",
      "dist/cache/credentials.enc",
      "ui/nested/setup.html",
      "skills/pan-sync-upload/private.txt",
      "dist/ui/setup.html",
      "dist/skills/pan-sync-upload/SKILL.md",
    ];

    expect(packageViolations(unsafePaths)).toHaveLength(unsafePaths.length);
  });

  it("fails the asset gate when any required setup asset is absent", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "pan-sync-assets-"));
    temporaryDirectories.push(fixture);
    await mkdir(path.join(fixture, "ui"));
    await writeFile(path.join(fixture, "ui", "setup.html"), "<!doctype html>");
    await writeFile(path.join(fixture, "ui", "setup.js"), "void 0;\n");

    const copied = spawnSync(
      process.execPath,
      [path.resolve("scripts/copy-assets.mjs")],
      { cwd: fixture, encoding: "utf8", timeout: 10_000 },
    );

    expect(copied.error).toBeUndefined();
    expect(copied.status).not.toBe(0);
  });
});
