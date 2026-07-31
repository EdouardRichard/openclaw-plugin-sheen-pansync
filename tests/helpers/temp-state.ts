import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createTempState(): Promise<{
  dataDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pan-sync-helper-"));
  return {
    dataDir: path.join(root, "plugin-data"),
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

export async function octalMode(target: string): Promise<string> {
  return ((await stat(target)).mode & 0o777).toString(8);
}
