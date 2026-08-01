import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBuiltPackageFixture,
  type BuiltPackageFixture,
} from "../helpers/package-fixture.js";

type PackResult = Array<{
  filename?: string;
  files?: Array<{ path?: string }>;
}>;

type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const temporaryDirectories: string[] = [];
let packageFixture: BuiltPackageFixture | undefined;
const allowedUiFiles = new Set([
  "ui/setup.html",
  "ui/setup.js",
  "ui/setup.css",
]);
const allowedSkillFiles = new Set([
  "skills/pan-sync-upload/SKILL.md",
]);
const rejectedPackageRoots = new Set([
  ".superpowers",
  "node_modules",
  "src",
  "tests",
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
      || rejectedPackageRoots.has(segments[0] ?? "")
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

function packageFixtureRoot(): string {
  if (packageFixture === undefined) {
    throw new Error("built package fixture unavailable");
  }
  return packageFixture.root;
}

function runNpm(args: readonly string[]) {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error("npm CLI path unavailable");
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd: packageFixtureRoot(),
    encoding: "utf8",
    timeout: 60_000,
  });
}

function readPackedText(tarball: string, packagePath: string): string {
  const extracted = spawnSync(
    "tar",
    ["-xOf", tarball, `package/${packagePath}`],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (extracted.error !== undefined || extracted.status !== 0) {
    throw new Error(`could not read packed asset: ${packagePath}`);
  }
  return extracted.stdout;
}

function localMarkdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .flatMap((match) => match[1] === undefined ? [] : [match[1]])
    .filter((target) => !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/iu.test(target))
    .map((target) => normalizePackagePath(target.split(/[?#]/u, 1)[0] ?? ""))
    .filter((target) => target.length > 0);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<ProcessExit> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function waitForReadiness(
  child: ChildProcessWithoutNullStreams,
  readStdout: () => string,
  timeoutMs: number,
): Promise<"ready" | "exited" | "error" | "timeout"> {
  return new Promise((resolve) => {
    const finish = (result: "ready" | "exited" | "error" | "timeout"): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(result);
    };
    const onData = (): void => {
      if (readStdout().includes("Remote URL:")) finish("ready");
    };
    const onExit = (): void => finish("exited");
    const onError = (): void => finish("error");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish("exited");
      return;
    }
    onData();
  });
}

beforeAll(async () => {
  packageFixture = await createBuiltPackageFixture();
}, 60_000);

afterAll(async () => {
  await packageFixture?.cleanup();
  packageFixture = undefined;
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
      "cli-metadata.js",
      "dist/index.js",
      "dist/admin/cli.js",
      "dist/cli-entry.js",
      "ui/setup.html",
      "ui/setup.js",
      "ui/setup.css",
      "skills/pan-sync-upload/SKILL.md",
      "openclaw.plugin.json",
      "README.md",
      "docs/guides/aliyun-token.md",
    ];
    for (const entry of required) {
      expect(paths, `missing package entry: ${entry}`).toContain(entry);
    }

    expect(packageViolations(paths)).toEqual([]);
    expect(paths.filter((entry) => /(?:canary|fixture|vault)/iu.test(entry))).toEqual([]);
  });

  it("ships every local documentation target linked by the packed README", async () => {
    const packDirectory = await mkdtemp(path.join(tmpdir(), "pan-sync-readme-links-"));
    temporaryDirectories.push(packDirectory);
    const packed = runNpm([
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
    ]);
    expect(packed.error).toBeUndefined();
    expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
    const report = JSON.parse(packed.stdout) as PackResult;
    const filename = report[0]?.filename;
    expect(filename).toBeTypeOf("string");
    const tarball = path.join(packDirectory, path.basename(filename ?? ""));
    const readme = readPackedText(tarball, "README.md");
    const targets = localMarkdownTargets(readme);

    expect(targets).not.toEqual([]);
    for (const target of targets) {
      expect(
        () => readPackedText(tarball, target),
        `missing packed README target: ${target}`,
      ).not.toThrow();
    }
  });

  it("keeps personal OAuth credential guidance out of the generated package assets", async () => {
    const userFacingFiles = [
      "README.md",
      "docs/guides/aliyun-token.md",
      "skills/pan-sync-upload/SKILL.md",
      "ui/setup.html",
      "ui/setup.js",
      "ui/setup.css",
    ];
    const packDirectory = await mkdtemp(path.join(tmpdir(), "pan-sync-packed-assets-"));
    temporaryDirectories.push(packDirectory);
    const packed = runNpm([
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
    ]);
    expect(packed.error).toBeUndefined();
    expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
    const report = JSON.parse(packed.stdout) as PackResult;
    const filename = report[0]?.filename;
    expect(filename).toBeTypeOf("string");
    const tarball = path.join(packDirectory, path.basename(filename ?? ""));
    const contents = userFacingFiles.map((file) => readPackedText(tarball, file));

    for (const content of contents) {
      expect(content).not.toMatch(/client[ _-]?(?:id|secret)/iu);
      expect(content).not.toMatch(/oauth\/access_token/iu);
      expect(content).not.toContain("shipped-custom-url-CANARY-e193");
    }
  });

  it("documents the OpenList-only setup flow and supersedes the separate web-system plan", async () => {
    const [guide, plan] = await Promise.all([
      readFile(new URL("../../docs/guides/aliyun-token.md", import.meta.url), "utf8"),
      readFile(
        new URL("../../docs/plans/token-acquisition-web-system.md", import.meta.url),
        "utf8",
      ),
    ]);

    expect(guide).toContain("https://api.oplist.org.cn");
    expect(guide).toContain("https://api.oplist.org.cn/alicloud/renewapi");
    expect(guide).toContain("paste only the refresh token");
    expect(guide).toContain("directly to Aliyun Drive");
    expect(guide).not.toMatch(/client[ _-]?(?:id|secret)/iu);
    expect(plan).toMatch(/^# Superseded:/u);
    expect(plan).toContain("2026-08-01-openlist-token-service-design.md");
    expect(plan).toContain("No separate Token web system is planned");
  });

  it("rejects nested private state and undeclared static content", () => {
    const unsafePaths = [
      "ui\\.env",
      "src/runtime-composition.ts",
      "node_modules/dependency/index.js",
      ".superpowers/sdd/private-report.md",
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

  it("launches pan-sync configure through the officially installed package", async () => {
    const verificationRoot = await mkdtemp(
      path.join(tmpdir(), "pan-sync-installed-cli-"),
    );
    const stateDir = path.join(verificationRoot, "state");
    const openClawCli = path.resolve("node_modules/openclaw/openclaw.mjs");
    const isolatedEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };
    delete isolatedEnvironment.OPENCLAW_CONFIG_PATH;
    delete isolatedEnvironment.OPENCLAW_DEBUG;
    let child: ChildProcessWithoutNullStreams | undefined;
    let exitPromise: Promise<ProcessExit> | undefined;

    try {
      const packed = runNpm([
        "pack",
        "--json",
        "--pack-destination",
        verificationRoot,
      ]);
      expect(packed.error, "package creation failed to launch").toBeUndefined();
      expect(packed.status, "package creation failed").toBe(0);
      const report = JSON.parse(packed.stdout) as PackResult;
      const filename = report[0]?.filename;
      expect(filename, "package creation did not return an artifact").toBeTypeOf(
        "string",
      );
      const tarball = path.join(verificationRoot, path.basename(filename ?? ""));

      const installed = spawnSync(
        process.execPath,
        [openClawCli, "plugins", "install", tarball],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: isolatedEnvironment,
          timeout: 60_000,
          windowsHide: true,
        },
      );
      expect(
        installed.error,
        "official plugin installation failed to launch",
      ).toBeUndefined();
      expect(installed.status, "official plugin installation failed").toBe(0);

      child = spawn(
        process.execPath,
        [openClawCli, "--no-color", "pan-sync", "configure"],
        {
          cwd: process.cwd(),
          env: isolatedEnvironment,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      child.stdin.end();
      exitPromise = waitForExit(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const readiness = await waitForReadiness(child, () => stdout, 30_000);
      const combinedOutput = `${stdout}\n${stderr}`;
      const registrationFailure = combinedOutput.includes(
        "failed during register",
      ) || combinedOutput.includes("cli-metadata");
      const unknownCommand = combinedOutput.includes("Unknown command");
      expect(
        readiness,
        `official CLI readiness=${readiness}; registrationFailure=${registrationFailure}; unknownCommand=${unknownCommand}`,
      ).toBe("ready");
      expect(registrationFailure).toBe(false);
      expect(unknownCommand).toBe(false);

      child.kill("SIGTERM");
      const graceful = await settlesWithin(exitPromise, 5_000);
      if (!graceful) {
        child.kill("SIGKILL");
        expect(
          await settlesWithin(exitPromise, 5_000),
          "official CLI did not exit after exact-child force termination",
        ).toBe(true);
      }
    } finally {
      if (child !== undefined && child.exitCode === null) {
        child.kill("SIGTERM");
        const graceful = exitPromise === undefined
          ? false
          : await settlesWithin(exitPromise, 2_000);
        if (!graceful && child.exitCode === null) {
          child.kill("SIGKILL");
          if (exitPromise !== undefined) {
            await settlesWithin(exitPromise, 2_000);
          }
        }
      }
      await rm(verificationRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
