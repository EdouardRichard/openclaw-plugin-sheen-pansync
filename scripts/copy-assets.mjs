import { access } from "node:fs/promises";

const requiredAssets = [
  "ui/setup.html",
  "ui/setup.js",
  "ui/setup.css",
];

await Promise.all(requiredAssets.map((asset) => access(asset)));
