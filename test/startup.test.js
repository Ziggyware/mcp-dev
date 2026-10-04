import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "index.js");

test("help fast-path does not create or read a config directory", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-help-"));
  const configDir = path.join(temp, "not-created");
  try {
    const result = spawnSync(process.execPath, [entry, "tools", "--help"], {
      cwd: root,
      env: { ...process.env, HOME: temp, MCP_DEV_CONFIG_DIR: configDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mcp-dev tools <server>/);
    assert.equal(fs.existsSync(configDir), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
