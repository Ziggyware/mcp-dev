import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHooks, HOOK_PREAMBLE } from "../src/agentHooks.js";
import { validateArguments } from "../src/schema.js";
import { ResultBuffer } from "../src/resultBuffer.js";

// ---------------------------------------------------------------- fake backend

const SERVICES = {
  files: {
    description: "workspace filesystem service",
    tools: [
      {
        name: "read_file",
        description: "Read one text file from the workspace",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "workspace-relative path" },
            encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Create or overwrite one text file (destructive)",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string", minLength: 1 },
          },
          required: ["path", "content"],
        },
        outputSchema: { type: "object", properties: { bytes: { type: "integer" } }, required: ["bytes"] },
      },
    ],
  },
  math: {
    description: "arithmetic demo service",
    tools: [
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    ],
  },
};

function makeContext({ confirmResult = true, executed = [], buffer = new ResultBuffer() } = {}) {
  const calls = [];
  const toolCache = new Map();
  const context = {
    servers: () => Object.fromEntries(Object.entries(SERVICES).map(([name, value]) => [name, { description: value.description }])),
    ensureTools: async (name) => {
      if (!SERVICES[name]) throw new Error(`No server named "${name}".`);
      if (!toolCache.has(name)) toolCache.set(name, [...SERVICES[name].tools]);
      return toolCache.get(name);
    },
    refresh: async (name) => {
      toolCache.set(name, [...SERVICES[name].tools]);
      return toolCache.get(name);
    },
    callToolFn: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, server, tool, args }) }] };
    },
    confirm: async (server, tool, args) => {
      calls.push({ confirm: true, server, tool, args });
      return confirmResult;
    },
    resultBuffer: buffer,
    callLog: [],
  };
  return { context, calls };
}

// ------------------------------------------------------------------- structure

test("exactly 20 disclosure hooks, each named, documented, and schema'd", () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  assert.equal(hookSet.defs.length, 20);
  const names = hookSet.names;
  assert.equal(new Set(names).size, 20);
  for (const def of hookSet.defs) {
    assert.ok(def.name.startsWith("mcp_"), def.name);
    assert.ok(def.description.length > 20, def.name);
    assert.equal(def.input_schema.type, "object", def.name);
  }
  const expected = [
    "mcp_services", "mcp_tools", "mcp_schema", "mcp_call", "mcp_batch",
    "mcp_search", "mcp_suggest", "mcp_describe", "mcp_validate", "mcp_draft",
    "mcp_examples", "mcp_plan", "mcp_results", "mcp_history", "mcp_explain",
    "mcp_health", "mcp_refresh", "mcp_resources", "mcp_read", "mcp_prompts",
  ];
  assert.deepEqual(names, expected);
});

test("levels: 1 = services, 2 = tools, 3 = schema, exec = call/batch", () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  assert.equal(hookSet.levels.mcp_services, 1);
  assert.equal(hookSet.levels.mcp_tools, 2);
  assert.equal(hookSet.levels.mcp_schema, 3);
  assert.equal(hookSet.levels.mcp_call, "exec");
  assert.equal(hookSet.levels.mcp_batch, "exec");
});

// ----------------------------------------------------------------- level 1..3

test("level 1 lists services by name without leaking schemas", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_services", {});
  assert.match(out.content, /files/);
  assert.match(out.content, /math/);
  assert.match(out.content, /2 calls/);
  assert.ok(!out.content.includes("inputSchema"));
  assert.ok(!out.content.includes("read_file"));
});

test("level 2 lists the calls of one service, still schema-free", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_tools", { service: "files" });
  assert.match(out.content, /read_file/);
  assert.match(out.content, /write_file/);
  assert.match(out.content, /path/);
  assert.ok(!out.content.includes('"type"'), "level 2 must not dump raw JSON schemas");
});

test("level 2 rejects unknown services with the level-1 hint", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_tools", { service: "nope" });
  assert.equal(out.is_error, true);
  assert.match(out.content, /mcp_services/);
  assert.match(out.content, /Registered/);
});

test("level 3 shows every parameter, requirements, and the response contract", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_schema", { service: "files", call: "write_file" });
  assert.match(out.content, /"required"/);
  assert.match(out.content, /path/);
  assert.match(out.content, /content/);
  assert.match(out.content, /outputSchema/, "declared outputSchema must be disclosed");
  const without = await hookSet.run("mcp_schema", { service: "files", call: "read_file" });
  assert.match(without.content, /content envelope/, "undisclosed responses explain the MCP envelope");
});

test("level 3 for a call with no parameters says to pass {}", async () => {
  const { context } = makeContext();
  SERVICES.stop = { description: "noop", tools: [{ name: "halt", inputSchema: { type: "object", properties: {} } }] };
  try {
    const hookSet = createMcpHooks(context);
    const out = await hookSet.run("mcp_schema", { service: "stop", call: "halt" });
    assert.match(out.content, /empty object/);
  } finally {
    delete SERVICES.stop;
  }
});

// ------------------------------------------------------------------ execution

test("mcp_call executes any service call only after approval", async () => {
  const { context, calls } = makeContext({ confirmResult: true });
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_call", { service: "math", call: "add", arguments: { a: 2, b: 3 } });
  assert.equal(out.is_error, false);
  assert.match(out.content, /math\/add executed/);
  assert.match(out.content, /"a":2/);
  assert.ok(calls.some((entry) => entry.confirm));
  assert.ok(calls.some((entry) => entry.tool === "add"));
});

test("mcp_call is hard-gated: a declined call never reaches the service", async () => {
  const { context, calls } = makeContext({ confirmResult: false });
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_call", { service: "math", call: "add", arguments: { a: 2, b: 3 } });
  assert.equal(out.is_error, true);
  assert.match(out.content, /declined/);
  assert.ok(!calls.some((entry) => !entry.confirm && entry.tool === "add"), "no execution after decline");
});

test("mcp_call validates before asking for approval", async () => {
  const { context, calls } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_call", { service: "math", call: "add", arguments: { a: "not a number" } });
  assert.equal(out.is_error, true);
  assert.match(out.content, /schema validation/);
  assert.ok(!calls.some((entry) => entry.confirm), "invalid args must not be shown for approval");
  assert.ok(!calls.some((entry) => entry.tool === "add"));
});

test("mcp_call records successful results into the result buffer", async () => {
  const buffer = new ResultBuffer();
  const { context } = makeContext({ buffer });
  const hookSet = createMcpHooks(context);
  await hookSet.run("mcp_call", { service: "math", call: "add", arguments: { a: 1, b: 2 } });
  assert.equal(buffer.list().length, 1);
  assert.equal(buffer.list()[0].server, "math");
  const listed = await hookSet.run("mcp_results", {});
  assert.match(listed.content, /#1 math\/add/);
});

test("mcp_batch confirms and runs each call, and enforces the batch cap", async () => {
  const { context, calls } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_batch", {
    calls: [
      { service: "math", call: "add", arguments: { a: 1, b: 1 } },
      { service: "files", call: "read_file", arguments: { path: "a.txt" } },
    ],
  });
  assert.match(out.content, /Batch report/);
  assert.match(out.content, /math\/add: ok/);
  assert.equal(calls.filter((entry) => entry.confirm).length, 2);

  const tooMany = await hookSet.run("mcp_batch", {
    calls: Array.from({ length: 11 }, () => ({ service: "math", call: "add", arguments: { a: 1, b: 1 } })),
  });
  assert.equal(tooMany.is_error, true);
  assert.match(tooMany.content, /at most 10/);
});

// ------------------------------------------------------- assist: search etc.

test("mcp_search ranks across services and reports the winner", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_search", { query: "read file" });
  assert.match(out.content, /files\/read_file/);
  const none = await hookSet.run("mcp_search", { query: "zzzznotfound" });
  assert.match(none.content, /No call matches/);
});

test("mcp_suggest maps a goal to candidates with relevance", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_suggest", { goal: "overwrite a file with new content" });
  assert.match(out.content, /files\/write_file/);
  const gap = await hookSet.run("mcp_suggest", { goal: "deploy kubernetes cluster to mars" });
  assert.match(gap.content, /No registered call matches/);
});

test("mcp_describe explains parameters and flags risky calls", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const risky = await hookSet.run("mcp_describe", { service: "files", call: "write_file" });
  assert.match(risky.content, /destructive/i);
  assert.match(risky.content, /required/);
  const calm = await hookSet.run("mcp_describe", { service: "files", call: "read_file" });
  assert.ok(!/destructive/i.test(calm.content));
});

test("mcp_validate returns precise errors without executing", async () => {
  const { context, calls } = makeContext();
  const hookSet = createMcpHooks(context);
  const bad = await hookSet.run("mcp_validate", { service: "math", call: "add", arguments: { a: 1 } });
  assert.equal(bad.is_error, true);
  assert.match(bad.content, /required/);
  const good = await hookSet.run("mcp_validate", { service: "math", call: "add", arguments: { a: 1, b: 2 } });
  assert.match(good.content, /satisfy the schema/);
  assert.ok(!calls.some((entry) => entry.tool === "add"));
});

test("mcp_draft produces arguments that pass schema validation", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_draft", { service: "files", call: "write_file" });
  assert.match(out.content, /"path"/);
  assert.match(out.content, /placeholders/i);
  const jsonBlock = /\{[\s\S]*?\n\}/.exec(out.content)?.[0];
  assert.ok(jsonBlock, "draft embeds a JSON object");
  const draft = JSON.parse(jsonBlock);
  assert.ok(validateArguments(SERVICES.files.tools[1].inputSchema, draft).valid, "the draft itself must be schema-valid");
});

test("mcp_examples emits a minimal and a full variant", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_examples", { service: "files", call: "write_file" });
  assert.match(out.content, /minimal/);
  assert.match(out.content, /typical/);
  assert.match(out.content, /Replace placeholder values/);
});

test("mcp_plan structures a goal into candidates", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_plan", { goal: "read a file then write a copy" });
  assert.match(out.content, /Draft plan/);
  assert.match(out.content, /read_file/);
  assert.match(out.content, /write_file/);
});

// ----------------------------------------------------------------- memory etc.

test("mcp_history journals executions and mcp_explain dissects results", async () => {
  const buffer = new ResultBuffer();
  const { context } = makeContext({ buffer });
  const hookSet = createMcpHooks(context);
  await hookSet.run("mcp_call", { service: "math", call: "add", arguments: { a: 4, b: 5 } });
  const history = await hookSet.run("mcp_history", {});
  assert.match(history.content, /math\/add/);
  assert.match(history.content, /→ ok/);
  const explained = await hookSet.run("mcp_explain", { index: 1 });
  assert.match(explained.content, /Structure:/);
  const missing = await hookSet.run("mcp_explain", { index: 99 });
  assert.match(missing.content, /No cached result #99/);
});

test("mcp_health reports reachability and mcp_refresh reports diffs", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const health = await hookSet.run("mcp_health", {});
  assert.match(health.content, /✓ files/);
  assert.match(health.content, /✓ math/);
  SERVICES.files.tools.push({ name: "delete_all", description: "new capability", inputSchema: { type: "object", properties: {} } });
  try {
    const out = await hookSet.run("mcp_refresh", { service: "files" });
    assert.match(out.content, /added: delete_all/);
    assert.match(out.content, /3 calls/);
  } finally {
    SERVICES.files.tools.pop();
  }
});

test("resource and prompt hooks resolve services and degrade gracefully", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const noSupport = await hookSet.run("mcp_resources", { service: "files" });
  assert.equal(noSupport.is_error, true);
  context.listResources = async () => [{ uri: "file:///notes.md", name: "notes", mimeType: "text/markdown" }];
  context.readResource = async () => ({ contents: [{ text: "# notes" }] });
  const listed = await hookSet.run("mcp_resources", { service: "files" });
  assert.match(listed.content, /file:\/\/\/notes.md/);
  const read = await hookSet.run("mcp_read", { service: "files", uri: "file:///notes.md" });
  assert.match(read.content, /# notes/);
  const unknown = await hookSet.run("mcp_read", { service: "ghost", uri: "file:///x" });
  assert.equal(unknown.is_error, true);
});

test("mcp_prompts lists and renders prompt templates", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  context.listPrompts = async () => [{ name: "review", description: "review a file" }];
  context.getPrompt = async (server, name, args) => ({
    messages: [{ role: "user", content: { type: "text", text: `review ${args?.path ?? "?"} on ${server} via ${name}` } }],
  });
  const listed = await hookSet.run("mcp_prompts", { service: "files" });
  assert.match(listed.content, /review/);
  const rendered = await hookSet.run("mcp_prompts", { service: "files", prompt: "review", arguments: { path: "a.txt" } });
  assert.match(rendered.content, /review a\.txt/);
});

test("an unknown hook name is an explicit error listing the toolkit", async () => {
  const { context } = makeContext();
  const hookSet = createMcpHooks(context);
  const out = await hookSet.run("mcp_frobnicate", {});
  assert.equal(out.is_error, true);
  assert.match(out.content, /mcp_services/);
});

test("the preamble teaches the L1→L2→L3 protocol", () => {
  assert.match(HOOK_PREAMBLE, /mcp_services/);
  assert.match(HOOK_PREAMBLE, /mcp_tools/);
  assert.match(HOOK_PREAMBLE, /mcp_schema/);
  assert.match(HOOK_PREAMBLE, /approval/);
});
