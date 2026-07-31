import { readFile } from "node:fs/promises";
import path from "node:path";

export type SetupPageAsset = {
  contentType: string;
  body: Buffer;
};

export type SetupPageAssets = ReadonlyMap<string, SetupPageAsset>;

const ASSET_DEFINITIONS = [
  ["/", "setup.html", "text/html; charset=utf-8"],
  ["/setup.js", "setup.js", "text/javascript; charset=utf-8"],
  ["/setup.css", "setup.css", "text/css; charset=utf-8"],
] as const;

export async function readSetupPageAssets(
  assetsDir: string,
): Promise<SetupPageAssets> {
  const entries = await Promise.all(
    ASSET_DEFINITIONS.map(async ([route, filename, contentType]) => [
      route,
      {
        contentType,
        body: await readFile(path.join(assetsDir, filename)),
      },
    ] as const),
  );
  return new Map(entries);
}
