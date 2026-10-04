import assert from "node:assert/strict";
import test from "node:test";
import { completionsFor, interpretInput, parseCacheRef, previewFor } from "../src/sessionInput.js";
import { ResultBuffer } from "../src/resultBuffer.js";

function context({ apiKey = false, withTools = true } = {}) {
  const buffer = new ResultBuffer();
  const tools = [
    { name: "echo", description: "Echo the text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  ];
  const toolsByServer = new Map();
  if (withTools) toolsByServer.set("demo", tools);
  return {
    servers: ["demo"],
    toolsByServer,
    apiKey,
    resultBuffer: buffer,
    cacheOrigin: new Map([["demo", withTools ? "cached" : ""]]),
    connected: new Set(),
    descriptions: { demo: "fixture" },
  };
}

test("plain text is chat, but never the default action without an API key", () => {
  const withoutKey = context({ apiKey: false });
  assert.equal(interpretInput("wo", withoutKey).type, "chat");
  const completions = completionsFor("wo", withoutKey);
  assert.equal(completions.items.some((item) => item.kind === "chat"), false);
  assert.match(completions.note, /ANTHROPIC_API_KEY/);
  // No chat entry is offered, but the entries that do work still are.
  assert.ok(completions.items.length > 0);
  const wordnet = { ...withoutKey, servers: ["wordnet"], toolsByServer: new Map(), descriptions: { wordnet: "" } };
  assert.ok(completionsFor("wo", wordnet).items.some((item) => item.label === "/wordnet/"));
  assert.match(previewFor("wo", withoutKey).join("\n"), /ANTHROPIC_API_KEY/);

  const withKey = context({ apiKey: true });
  const chatItems = completionsFor("wo", withKey).items;
  assert.equal(chatItems[0].kind, "chat");
  assert.equal(chatItems[0].complete, false, "the chat line submits the literal text, it is not a completion");
  assert.equal(chatItems[0].submitText, "wo");
});

test("commands, servers, and tools are routed distinctly", () => {
  const ctx = context();
  assert.equal(interpretInput("", ctx).type, "empty");
  assert.equal(interpretInput("/servers", ctx).type, "command");
  assert.equal(interpretInput("/result 3.name", ctx).type, "command");
  assert.equal(interpretInput("/call demo read_file", ctx).command.name, "call");
  assert.deepEqual(interpretInput("/call demo read_file", ctx).args, ["demo", "read_file"]);
  assert.equal(interpretInput("/demo/", ctx).type, "server");
  assert.equal(interpretInput("/demo/echo", ctx).type, "tool");
  assert.equal(interpretInput("/demo/ec", ctx).type, "server", "a partial tool name opens the filtered browser");
  assert.equal(interpretInput("/demo/echo {\"text\":\"hi\"}", ctx).inline, true);
  assert.deepEqual(interpretInput("/demo/echo {\"text\":\"hi\"}", ctx).args, { text: "hi" });
  assert.equal(interpretInput("/nope", ctx).type, "unknown");
  assert.equal(interpretInput("//literal", ctx).type, "slash-chat");
  assert.equal(interpretInput("!3", ctx).type, "cache");
});

test("completions explain what each match does", () => {
  const ctx = context({ apiKey: true });
  const commands = completionsFor("/ser", ctx).items;
  assert.equal(commands[0].label, "/servers");
  assert.ok(commands[0].description.includes("connection state"));

  const tools = completionsFor("/demo/re", ctx).items;
  assert.equal(tools[0].label, "read_file");
  assert.equal(tools[0].regionStart, "/demo/".length);
  assert.ok(tools[0].description.includes("Read a file"));

  const empty = completionsFor("", ctx).items;
  assert.ok(empty.length > 0);
  assert.ok(empty.every((item) => item.label && item.description !== undefined));

  assert.match(previewFor("/demo/echo", ctx).join("\n"), /params: text\* string/);
  assert.match(previewFor("/demo/", ctx).join("\n"), /2 tools/);
  assert.match(previewFor("/help", ctx).join("\n"), /usage: \/help/);
});

test("cached results surface as completions with previews", () => {
  const ctx = context();
  ctx.resultBuffer.push({
    server: "demo",
    tool: "lookup",
    args: {},
    mcpResult: { content: [{ type: "text", text: JSON.stringify({ rows: [{ id: 7 }] }) }] },
  });
  const items = completionsFor("!", ctx).items;
  const labels = items.map((item) => item.label);
  assert.ok(labels.includes("!!"));
  assert.ok(labels.includes("!1"));
  assert.ok(labels.includes("!1.rows[0].id"));
  assert.ok(items.every((item) => item.regionStart === 0));

  assert.ok(parseCacheRef("!2.rows[0]"));
  assert.equal(parseCacheRef("2.rows[0]"), false);
});
