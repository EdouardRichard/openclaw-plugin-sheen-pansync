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
import { materializedNpmArtifactEnvironment } from "../helpers/npm-artifact-environment.js";
import { withOpenClawInstallLease } from "../helpers/openclaw-install-lease.mjs";

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
const allowedReadmeImages = new Set([
  "docs/images/readme/01-plugin-ready.png",
  "docs/images/readme/02-upload-resource-drive.png",
  "docs/images/readme/03-search-resource-drive.png",
  "docs/images/readme/04-download-and-read.png",
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
      || (segments[0] === "skills" && !allowedSkillFiles.has(normalized))
      || (normalized.startsWith("docs/images/readme/")
        && !allowedReadmeImages.has(normalized));
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
    env: materializedNpmArtifactEnvironment(),
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

function readPackedBuffer(tarball: string, packagePath: string): Buffer {
  const extracted = spawnSync(
    "tar",
    ["-xOf", tarball, `package/${packagePath}`],
    { encoding: null, timeout: 10_000 },
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
  it("materializes a tarball when the parent npm lifecycle is a dry run", async () => {
    const packDirectory = await mkdtemp(
      path.join(tmpdir(), "pan-sync-parent-dry-run-"),
    );
    temporaryDirectories.push(packDirectory);
    const previousDryRun = process.env.npm_config_dry_run;
    process.env.npm_config_dry_run = "true";

    try {
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
      await expect(readFile(tarball)).resolves.toBeInstanceOf(Buffer);
    } finally {
      if (previousDryRun === undefined) {
        delete process.env.npm_config_dry_run;
      } else {
        process.env.npm_config_dry_run = previousDryRun;
      }
    }
  });

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
      "dist/providers/aliyun/download-start-limiter.js",
      "dist/providers/aliyun/sqlite-download-start-store.js",
      "ui/setup.html",
      "ui/setup.js",
      "ui/setup.css",
      "skills/pan-sync-upload/SKILL.md",
      "openclaw.plugin.json",
      "LICENSE",
      "README.md",
      "docs/guides/aliyun-token.md",
      ...allowedReadmeImages,
    ];
    for (const entry of required) {
      expect(paths, `missing package entry: ${entry}`).toContain(entry);
    }

    expect(packageViolations(paths)).toEqual([]);
    expect(paths.filter((entry) => /(?:canary|fixture|vault)/iu.test(entry))).toEqual([]);
  });

  it("ships the serialized transfer Skill contract", async () => {
    const packDirectory = await mkdtemp(path.join(tmpdir(), "pan-sync-packed-skill-"));
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
    const skill = readPackedText(
      path.join(packDirectory, path.basename(filename ?? "")),
      "skills/pan-sync-upload/SKILL.md",
    );

    expect(skill).toMatch(/did not explicitly specify[\s\S]*omit `localDirectory`/iu);
    expect(skill).toMatch(/never derive `localDirectory`[\s\S]*remotePath/iu);
    expect(skill).toMatch(/one at a time[\s\S]*pan_sync_download|pan_sync_download[\s\S]*one at a time/iu);
    expect(skill).toMatch(/never[\s\S]*concurrent[\s\S]*pan_sync_download/iu);
    expect(skill).toMatch(/combine[\s\S]*paths[\s\S]*one `pan_sync_upload`/iu);
    expect(skill).toMatch(/never[\s\S]*concurrent[\s\S]*pan_sync_upload/iu);
    expect(skill).toMatch(/do not immediately retry|no tight retry loop/iu);
    expect(skill).toMatch(/continue the remaining planned files/iu);
    expect(skill).toMatch(/一台主机[\s\S]*所有会话[\s\S]*严格滑动窗口[\s\S]*60 秒[\s\S]*2 次/u);
    expect(skill).toMatch(/pending[\s\S]*pan_sync_download[\s\S]*自动恢复/u);
    expect(skill).toMatch(/pending[\s\S]*不得[\s\S]*重复/u);
    expect(skill).toMatch(/pending[\s\S]*不得[\s\S]*自动重试/u);
    expect(skill).toMatch(/不得[\s\S]*另开会话[\s\S]*绕过/u);
    expect(skill).toMatch(/DOWNLOAD_FAILED[\s\S]*(?:最终|final)[\s\S]*(?:紧密重试|tight retry)/u);
    expect(skill).toMatch(/all sessions[\s\S]*one host[\s\S]*strict sliding window[\s\S]*two starts per 60 seconds/iu);
    expect(skill).toMatch(/pending[\s\S]*pan_sync_download[\s\S]*resumes automatically/iu);
    expect(skill).toMatch(/must not[\s\S]*duplicate[\s\S]*pending/iu);
    expect(skill).toMatch(/must not[\s\S]*automatic retry[\s\S]*pending/iu);
    expect(skill).toMatch(/must not start another session[\s\S]*workaround/iu);
    expect(skill).toMatch(/DOWNLOAD_FAILED[\s\S]*final[\s\S]*tight retry/iu);
  });

  it("ships the beginner setup guide and four valid screenshots", async () => {
    const packDirectory = await mkdtemp(path.join(tmpdir(), "pan-sync-readme-images-"));
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
    const paths = report[0]?.files?.flatMap(({ path: entry }) =>
      entry === undefined ? [] : [normalizePackagePath(entry)]
    ) ?? [];
    const tarball = path.join(packDirectory, path.basename(filename ?? ""));
    const readme = readPackedText(tarball, "README.md");

    expect(readme).toContain("# OpenClaw Sheen PanSync");
    expect(readme).toContain(
      "openclaw plugins install npm:openclaw-plugin-sheen-pansync",
    );
    expect(readme).toContain("plugins inspect sheen-pansync --runtime --json");
    expect(readme).toContain("MIT");
    expect(readme).not.toContain("npm:openclaw-pan-sync-helper");
    expect(readme).toContain("pan_sync_upload");
    expect(readme).toContain("pan_sync_list");
    expect(readme).toContain("pan_sync_download");
    expect(readme).toContain("资源盘");
    expect(readme).toContain("resource drive");
    expect(readme).toContain("DOWNLOAD_CONFIRMATION_REQUIRED");
    expect(readme).toContain("2 次/60 秒");
    expect(readme).toContain("two starts per 60 seconds");
    expect(readme).toMatch(/保守策略[\s\S]*社区[\s\S]*观察[\s\S]*并非官方[\s\S]*保证/u);
    expect(readme).toMatch(/第三次[\s\S]*(?:等待|挂起)[\s\S]*(?:窗口|60 秒)[\s\S]*自动继续/u);
    expect(readme).toMatch(/conservative compatibility[\s\S]*community reports[\s\S]*observed behavior[\s\S]*not a published official guarantee/iu);
    expect(readme).toMatch(/third[\s\S]*(?:wait|pending)[\s\S]*(?:window|60 seconds)[\s\S]*continues automatically/iu);

    expect(paths.filter((entry) => entry.startsWith("docs/images/readme/")))
      .toEqual([...allowedReadmeImages]);
    for (const imagePath of allowedReadmeImages) {
      const png = readPackedBuffer(tarball, imagePath);
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(png.readUInt32BE(16), `${imagePath} width`).toBeGreaterThan(0);
      expect(png.readUInt32BE(20), `${imagePath} height`).toBeGreaterThan(0);
      expect(png.byteLength, `${imagePath} size`).toBeLessThan(2 * 1024 * 1024);
    }
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
      "docs/images/readme/unapproved.png",
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

      const installed = await withOpenClawInstallLease(() =>
        spawnSync(
          process.execPath,
          [openClawCli, "plugins", "install", tarball],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: isolatedEnvironment,
            timeout: 90_000,
            windowsHide: true,
          },
        )
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
      expect(
        graceful,
        "official CLI did not exit gracefully after SIGTERM",
      ).toBe(true);
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
  }, 420_000);
});
