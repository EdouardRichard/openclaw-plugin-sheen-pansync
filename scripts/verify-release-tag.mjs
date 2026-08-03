import { readFile } from "node:fs/promises";

const tag = process.env.GITHUB_REF_NAME;
const stableTagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

if (tag === undefined || !stableTagPattern.test(tag)) {
  throw new Error(
    "GITHUB_REF_NAME must be a stable SemVer tag such as v1.2.3",
  );
}

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expectedTag = `v${packageJson.version}`;

if (tag !== expectedTag) {
  throw new Error(
    `release tag ${tag} does not match package.json version ${packageJson.version}`,
  );
}

console.log(`release tag ${tag} matches package version`);
