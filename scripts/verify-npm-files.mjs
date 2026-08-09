import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const mustExist = [
  "dist/index.js",
  "dist/setup-entry.js",
  "dist/runtime-api.js",
  "index.ts",
  "setup-entry.ts",
  "runtime-api.ts",
  "openclaw.plugin.json",
];
for (const f of mustExist) {
  await access(join(root, f));
}
