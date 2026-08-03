import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureEntries = [
  "src",
  "scripts",
  "ui",
  "skills",
  "docs/guides/aliyun-token.md",
  "docs/images/readme",
  "LICENSE",
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "cli-metadata.js",
  "openclaw.plugin.json",
  "README.md",
] as const;

export type BuiltPackageFixture = {
  root: string;
  artifactDirectory: string;
  cleanup(): Promise<void>;
};

export async function createBuiltPackageFixture(): Promise<BuiltPackageFixture> {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error("npm CLI path unavailable");
  const root = await mkdtemp(path.join(tmpdir(), "pan-sync-package-fixture-"));
  const nodeModulesLink = path.join(root, "node_modules");
  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };

  try {
    await Promise.all(fixtureEntries.map(async (entry) => {
      const destination = path.join(root, entry);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(projectRoot, entry), destination, { recursive: true });
    }));
    await symlink(
      path.join(projectRoot, "node_modules"),
      nodeModulesLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await execFileAsync(
        process.execPath,
        [npmCli, "run", "build"],
        {
          cwd: root,
          timeout: 60_000,
          windowsHide: true,
        },
      );
    } finally {
      await unlink(nodeModulesLink).catch(() => undefined);
    }
    return {
      root,
      artifactDirectory: path.join(root, "dist"),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
