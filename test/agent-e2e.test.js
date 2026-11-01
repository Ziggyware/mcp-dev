import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMcpHooks } from "../src/agentHooks.js";
import { getOrConnectServer, callTool, closeAllClients, listTools, withTimeout } from "../src/mcpClient.js";
import { ResultBuffer } from "../src/resultBuffer.js";
import { runAgentTurnOpenAI } from "../src/openaiAgent.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "test", "fixtures", "echo-server.mjs");

const ECHO_ENTRY = { command: process.execPath, args: [fixture], description: "echo fixture" };

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A mock OpenAI-compatible router that plays the progressive-disclosure protocol. */
function startScriptedRouter(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      const step = script[Math.min(requests.length, script.length - 1)];
      requests.push({ body: parsed });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const payload of step(parsed)) res.write(sse(payload));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, close: () => new Promise((done) => server.close(done)) }));
  });
}

function toolCallsDelta(calls) {
  return [{ choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ index, id: `call_${index}`, type: "function", function: call })) } }] }];
}

function textDelta(text) {
  return [{ choices: [{ index: 0, delta: { content: text } }] }];
}

test("e2e: nokey-wire agent drives a real stdio MCP service through L1→L2→execute", async () => {
  const approvals = [];
  const resultBuffer = new ResultBuffer();
  const hookSet = createMcpHooks({
    servers: () => ({ echofix: ECHO_ENTRY }),
    ensureTools: async (name) => {
      const client = await getOrConnectServer(name, ECHO_ENTRY, { timeoutMs: 10_000 });
      return withTimeout(listTools(client, { timeout: 10_000, maxTotalTimeout: 10_000 }), 10_000, "listing timed out");
    },
    callToolFn: async (server, tool, args) => {
      const client = await getOrConnectServer(server, ECHO_ENTRY, { timeoutMs: 10_000 });
      return callTool(client, tool, args, { timeout: 10_000, maxTotalTimeout: 10_000 });
    },
    confirm: async (server, tool, args) => {
      approvals.push({ server, tool, args });
      return true;
    },
    resultBuffer,
    callLog: [],
  });

  const router = await startScriptedRouter([
    () => toolCallsDelta([{ name: "mcp_services", arguments: "{}" }]),
    () => toolCallsDelta([{ name: "mcp_tools", arguments: '{"service":"echofix"}' }]),
    () => toolCallsDelta([{ name: "mcp_call", arguments: '{"service":"echofix","call":"echo","arguments":{"text":"hello from nokey"}}' }]),
    (body) => {
      const toolMessages = body.messages.filter((message) => message.role === "tool");
      const callResult = toolMessages.at(-1)?.content ?? "";
      assert.match(callResult, /hello from nokey/, "the echoed payload must reach the model");
      assert.match(callResult, /result #1/, "the buffer index is disclosed for reuse");
      return textDelta("The echo service repeated the text.");
    },
  ]);

  try {
    const result = await runAgentTurnOpenAI({
      messages: [],
      toolDefs: hookSet.defs,
      brain: { kind: "openai", base: `http://127.0.0.1:${router.server.address().port}/v1`, apiKey: "nokey", model: "free:smart" },
      userQuery: "what can the echo service do?",
      system: "protocol",
      dispatch: (name, input) => hookSet.run(name, input),
    });
    assert.equal(result.text, "The echo service repeated the text.");
    assert.equal(resultBuffer.list().length, 1, "executions land in the result buffer");
    assert.equal(resultBuffer.list()[0].tool, "echo");
    assert.equal(approvals.length, 1, "exactly one approval gate before execution");
    assert.equal(approvals[0].tool, "echo");
  } finally {
    await router.close();
    await closeAllClients();
  }
});

test("e2e: `mcp-dev ask` runs on the nokey brain with zero API keys", async () => {
  const router = await startScriptedRouter([
    () => textDelta("answered without touching any service"),
  ]);
  const port = router.server.address().port;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-e2e-"));
  const env = {
    ...process.env,
    MCP_DEV_CONFIG_DIR: configDir,
    NOKEY_ROUTER_URL: `http://127.0.0.1:${port}/v1`,
    MCP_DEV_BRAIN: "nokey",
  };
  delete env.ANTHROPIC_API_KEY;
  // spawn, never spawnSync: the mock router shares this process's event loop,
  // which must stay live while the child is running.
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "src", "index.js"), ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });

  try {
    const registered = await run(["register", "echofix", "--command", process.execPath, "--arg", fixture, "--force"]);
    assert.equal(registered.status, 0, registered.stderr);

    const asked = await run(["ask", "--brain", "nokey", "say hi"]);
    assert.equal(asked.status, 0, `stderr: ${asked.stderr}\nstdout: ${asked.stdout}`);
    assert.match(asked.stdout, /brain: nokey-router:free:smart/);
    assert.match(asked.stdout, /progressive hooks/);
    assert.match(asked.stdout, /answered without touching any service/);
  } finally {
    await router.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
