import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (await exists("package-lock.json")) {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) {
    throw new Error("npm CLI path unavailable; cannot build the package");
  }

  const result = spawnSync(process.execPath, [npmCli, "run", "build"], {
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  await Promise.all([
    "dist/index.js",
    "dist/index.d.ts",
    "cli-metadata.js",
    "openclaw.plugin.json",
    "ui/setup.html",
    "ui/setup.js",
    "ui/setup.css",
  ].map((path) => access(path)));
}
