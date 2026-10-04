import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "index.js");
const example = path.join(root, "examples", "dotnet-mcp-servers.json");

test("the .NET integration example loads as two independent stdio registrations", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-dotnet-"));
  const configPath = path.join(temp, "servers.json");

  try {
    fs.copyFileSync(example, configPath);
    const result = spawnSync(process.execPath, [entry, "list", "--json"], {
      cwd: root,
      env: { ...process.env, MCP_DEV_CONFIG_PATH: configPath },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        name: "vector-tools",
        transport: "stdio",
        target: "dotnet",
        args: 4,
        cwd: "/path/to/vector_tools",
        description: "ONNX 768-dimensional embedding and passage retrieval",
        allowSampling: false,
      },
      {
        name: "wordnet-dolma",
        transport: "stdio",
        target: "dotnet",
        args: 4,
        cwd: "/path/to/WordNetMcp",
        description: "WordNet lexical relations and 300-dimensional Dolma embeddings",
        allowSampling: false,
      },
    ]);

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(config.servers["wordnet-dolma"].args, [
      "/path/to/WordNetMcp/bin/Release/net10.0/WordNetMcp.dll",
      "/path/to/WordNetMcp/dict",
      "/path/to/dolma_300_2024_1.2M.100_combined.txt",
      "/path/to/dolma_sorted_index.bin",
    ]);
    assert.deepEqual(config.servers["vector-tools"].args, [
      "/path/to/vector_tools/bin/Release/net8.0/embed-retrieval.dll",
      "/path/to/model.onnx",
      "/path/to/vocab.txt",
      "/path/to/embeddings",
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
