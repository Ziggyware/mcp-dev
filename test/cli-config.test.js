import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "index.js");

function run(args, configDir) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, MCP_DEV_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

test("noninteractive registration is safe, scriptable, and uses an isolated config path", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-test-"));
  try {
    let result = run([
      "register", "demo", "--command", "node", "--args", "server.js --label 'two words'",
      "--env", "ONE=1,TWO='a,b'", "--description", "A demo server",
    ], configDir);
    assert.equal(result.status, 0, result.stderr);

    result = run(["list", "--json"], configDir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{
      name: "demo",
      transport: "stdio",
      target: "node",
      args: 3,
      description: "A demo server",
      allowSampling: false,
    }]);

    const configPath = path.join(configDir, "servers.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(config.servers.demo.args, ["server.js", "--label", "two words"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(configPath).mode & 0o077, 0);

    result = run(["unregister", "demo"], configDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--force/);
    result = run(["unregister", "demo", "--force"], configDir);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
