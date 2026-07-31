import { access, cp, mkdir } from "node:fs/promises";

const assets = ["ui", "skills"];

for (const asset of assets) {
  try {
    await access(asset);
  } catch {
    continue;
  }

  await mkdir(`dist/${asset}`, { recursive: true });
  await cp(asset, `dist/${asset}`, { recursive: true });
}
