import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sourceDir = path.resolve("src");
const files = fs.readdirSync(sourceDir)
  .filter((file) => file.endsWith(".js"))
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(sourceDir, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
