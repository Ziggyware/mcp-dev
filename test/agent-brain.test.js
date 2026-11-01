import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runAgentTurnOpenAI } from "../src/openaiAgent.js";
import { selectBrain } from "../src/brain.js";
import { getProviderArray, providerKey, resolveProvider } from "../src/providers.js";
import { anthropicToOpenAi, openAiAssistantToAnthropic } from "../src/wire.js";

// ------------------------------------------------------------------- providers

test("the nokey-router is always a configured provider, even with zero keys", () => {
  const providers = getProviderArray();
  const nokey = providers.find((provider) => provider.name === "nokey_router");
  assert.ok(nokey, "nokey_router must be present");
  assert.equal(nokey.base, "https://nokey-router.ziggyware.deno.net/v1");
  assert.equal(providerKey(nokey), "nokey");
  assert.equal(nokey.fallbackModel, "free:smart");
  assert.ok(providers[0].name === "nokey_router", "nokey sorts first (priority 0)");
});

test("NOKEY_ROUTER_MODEL and NOKEY_ROUTER_URL retarget the router", () => {
  const env = { ...process.env, NOKEY_ROUTER_MODEL: "free:reasoning", NOKEY_ROUTER_URL: "https://router.example.test/v1" };
  const saved = process.env.NOKEY_ROUTER_MODEL;
  process.env.NOKEY_ROUTER_MODEL = env.NOKEY_ROUTER_MODEL;
  process.env.NOKEY_ROUTER_URL = env.NOKEY_ROUTER_URL;
  try {
    const nokey = resolveProvider("nokey_router");
    assert.equal(nokey.fallbackModel, "free:reasoning");
    assert.equal(nokey.base, "https://router.example.test/v1");
  } finally {
    if (saved === undefined) delete process.env.NOKEY_ROUTER_MODEL;
    else process.env.NOKEY_ROUTER_MODEL = saved;
    delete process.env.NOKEY_ROUTER_URL;
  }
});

// ---------------------------------------------------------------------- brains

test("selectBrain: nokey by default, anthropic when keyed, forced overrides", () => {
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedForced = process.env.MCP_DEV_BRAIN;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MCP_DEV_BRAIN;
    let brain = selectBrain({});
    assert.equal(brain.kind, "openai");
    assert.equal(brain.provider, "nokey_router");
    assert.equal(brain.model, "free:smart");

    brain = selectBrain({ ANTHROPIC_API_KEY: "sk-test" });
    assert.equal(brain.kind, "anthropic");

    brain = selectBrain({ ANTHROPIC_API_KEY: "sk-test", MCP_DEV_BRAIN: "nokey" });
    assert.equal(brain.kind, "openai");
    assert.equal(brain.provider, "nokey_router");

    brain = selectBrain({ MCP_DEV_BRAIN: "anthropic", ANTHROPIC_API_KEY: "sk-test" });
    assert.equal(brain.kind, "anthropic");

    assert.throws(() => selectBrain({ MCP_DEV_BRAIN: "warp-core" }), /not a brain/);
    assert.throws(() => selectBrain({ MCP_DEV_BRAIN: "anthropic" }), /ANTHROPIC_API_KEY is not set/);
  } finally {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedForced === undefined) delete process.env.MCP_DEV_BRAIN;
    else process.env.MCP_DEV_BRAIN = savedForced;
  }
});

// ------------------------------------------------------------------------ wire

test("anthropicToOpenAi maps tool_use/tool_result round trips", () => {
  const messages = [
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_1", name: "mcp_services", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "files\nmath" },
        { type: "text", text: "and then some" },
      ],
    },
  ];
  const wire = anthropicToOpenAi(messages, { system: "be brief" });
  assert.equal(wire[0].role, "system");
  assert.deepEqual(wire[1], messages[0]);
  const assistant = wire[2];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "Checking.");
  assert.equal(assistant.tool_calls[0].function.name, "mcp_services");
  assert.equal(assistant.tool_calls[0].id, "toolu_1");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), {});
  const toolMessage = wire[3];
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.tool_call_id, "toolu_1");
  assert.equal(toolMessage.content, "files\nmath");
  assert.equal(wire[4].role, "user");
  assert.equal(wire[4].content, "and then some");

  const blocks = openAiAssistantToAnthropic({
    content: "Done.",
    tool_calls: [{ id: "c1", function: { name: "mcp_call", arguments: '{"service":"math"}' } }],
  });
  assert.deepEqual(blocks, [
    { type: "text", text: "Done." },
    { type: "tool_use", id: "c1", name: "mcp_call", input: { service: "math" } },
  ]);
});

// ----------------------------------------------------- openai-compatible brain

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Minimal OpenAI-compatible stand-in for the nokey-router. */
function startMockRouter({ handler }) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let payloads;
        try {
          const parsed = body ? JSON.parse(body) : {};
          requests.push({ auth: req.headers.authorization, path: req.url, body: parsed });
          payloads = handler(parsed, requests.length);
        } catch (error) {
          // An assertion failure inside the handler must fail fast, not hang the client.
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ mockError: String(error?.stack ?? error) }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const payload of payloads) {
          res.write(sseChunk(payload));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, close: () => new Promise((done) => server.close(done)) }));
  });
}

test("runAgentTurnOpenAI drives the nokey wire: stream → tool calls → dispatch → answer", async () => {
  const router = await startMockRouter({
    handler: (body, callIndex) => {
      if (callIndex === 1) {
        assert.equal(body.model, "free:smart");
        assert.equal(body.stream, true);
        assert.ok(body.tools.some((tool) => tool.function.name === "mcp_services"), "hook defs ride as OpenAI functions");
        assert.equal(body.messages[0].role, "system");
        return [
          { choices: [{ delta: { role: "assistant", content: "" }, index: 0 }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "mcp_", arguments: "" } }] }, index: 0 }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "services", arguments: "{}" } }] }, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
        ];
      }
      // The second request must carry the assistant tool_calls and the tool result.
      const toolMessages = body.messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 1);
      assert.equal(toolMessages[0].tool_call_id, "call_a");
      assert.match(toolMessages[0].content, /files/);
      return [
        { choices: [{ delta: { content: "There is one service: files." }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ];
    },
  });
  const saved = process.env.NOKEY_ROUTER_URL;
  process.env.NOKEY_ROUTER_URL = `http://127.0.0.1:${router.server.address().port}/v1`;

  const dispatches = [];
  try {
    const messages = [];
    const result = await runAgentTurnOpenAI({
      messages,
      toolDefs: [{ name: "mcp_services", description: "list services", input_schema: { type: "object", properties: {} } }],
      brain: selectBrain({ MCP_DEV_BRAIN: "nokey" }),
      userQuery: "which services exist?",
      system: "use hooks",
      dispatch: async (name, input) => {
        dispatches.push({ name, input });
        return { content: `services: files` };
      },
    });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].name, "mcp_services");
    assert.equal(result.text, "There is one service: files.");
    assert.equal(result.steps, 2);
    // Stored transcript stays Anthropic-shaped for the session UI.
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(messages[1].content.map((block) => block.type), ["tool_use"]);
    assert.equal(messages[2].role, "user");
    assert.deepEqual(messages[2].content[0].type, "tool_result");
    assert.match(router.requests[0].auth, /nokey/);
  } finally {
    if (saved === undefined) delete process.env.NOKEY_ROUTER_URL;
    else process.env.NOKEY_ROUTER_URL = saved;
    await router.close();
  }
});

test("runAgentTurnOpenAI reports dispatch failures as error tool results", async () => {
  const router = await startMockRouter({
    handler: (_body, callIndex) => {
      if (callIndex === 1) {
        return [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "mcp_boom", arguments: "not json" } }] }, index: 0 }] }];
      }
      const toolMessages = _body.messages.filter((message) => message.role === "tool");
      assert.match(toolMessages[0].content, /not valid JSON/);
      return [{ choices: [{ delta: { content: "recovered" }, index: 0 }] }];
    },
  });
  const saved = process.env.NOKEY_ROUTER_URL;
  process.env.NOKEY_ROUTER_URL = `http://127.0.0.1:${router.server.address().port}/v1`;
  try {
    const result = await runAgentTurnOpenAI({
      messages: [],
      toolDefs: [],
      brain: { kind: "openai", base: process.env.NOKEY_ROUTER_URL, apiKey: "nokey", model: "free:smart" },
      userQuery: "go",
      dispatch: async () => ({ content: "never" }),
    });
    assert.equal(result.text, "recovered");
  } finally {
    if (saved === undefined) delete process.env.NOKEY_ROUTER_URL;
    else process.env.NOKEY_ROUTER_URL = saved;
    await router.close();
  }
});

test("runAgentTurnOpenAI surfaces HTTP errors from the router", async () => {
  const errorServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unauthorized: Invalid ROUTER_API_KEY" } }));
  });
  await new Promise((resolve) => errorServer.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      runAgentTurnOpenAI({
        messages: [],
        toolDefs: [],
        brain: { kind: "openai", base: `http://127.0.0.1:${errorServer.address().port}/v1`, apiKey: "wrong", model: "free:smart" },
        userQuery: "go",
        dispatch: async () => ({ content: "" }),
      }),
      /HTTP 401/,
    );
  } finally {
    await new Promise((resolve) => errorServer.close(resolve));
  }
});

test("runAgentTurnOpenAI tolerates routers that answer JSON despite stream:true", async () => {
  const jsonServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "plain json answer" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve) => jsonServer.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runAgentTurnOpenAI({
      messages: [],
      toolDefs: [],
      brain: { kind: "openai", base: `http://127.0.0.1:${jsonServer.address().port}/v1`, apiKey: "nokey", model: "free:smart" },
      userQuery: "go",
      dispatch: async () => ({ content: "" }),
    });
    assert.equal(result.text, "plain json answer");
  } finally {
    await new Promise((resolve) => jsonServer.close(resolve));
  }
});

test("selectBrain names the missing env var for a forced-but-unkeyed provider", () => {
  const saved = process.env.MCP_DEV_BRAIN;
  const savedGroq = process.env.GROQ_API_KEY;
  try {
    delete process.env.GROQ_API_KEY;
    let threw = null;
    try {
      selectBrain({ MCP_DEV_BRAIN: "groq" });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "forcing an unkeyed provider must fail");
    assert.match(threw.message, /GROQ_API_KEY/);
  } finally {
    if (saved === undefined) delete process.env.MCP_DEV_BRAIN;
    else process.env.MCP_DEV_BRAIN = saved;
    if (savedGroq !== undefined) process.env.GROQ_API_KEY = savedGroq;
  }
});

test("runAgentTurnOpenAI retries once on transport-level failures, not on HTTP errors", async () => {
  let attempts = 0;
  const flaky = http.createServer((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      req.resume();
      res.destroy(); // dropped socket → fetch failed
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseChunk({ choices: [{ index: 0, delta: { content: "second attempt" } }] }));
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => flaky.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runAgentTurnOpenAI({
      messages: [],
      toolDefs: [],
      brain: { kind: "openai", base: `http://127.0.0.1:${flaky.address().port}/v1`, apiKey: "nokey", model: "free:smart" },
      userQuery: "go",
      dispatch: async () => ({ content: "" }),
    });
    assert.equal(result.text, "second attempt");
    assert.equal(attempts, 2);
  } finally {
    await new Promise((resolve) => flaky.close(resolve));
  }

  // HTTP errors are answers, not flakes: no retry.
  let unauthorized = 0;
  const strict = http.createServer((req, res) => {
    unauthorized += 1;
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no" } }));
  });
  await new Promise((resolve) => strict.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      runAgentTurnOpenAI({
        messages: [],
        toolDefs: [],
        brain: { kind: "openai", base: `http://127.0.0.1:${strict.address().port}/v1`, apiKey: "nokey", model: "free:smart" },
        userQuery: "go",
        dispatch: async () => ({ content: "" }),
      }),
      /HTTP 401/,
    );
    assert.equal(unauthorized, 1);
  } finally {
    await new Promise((resolve) => strict.close(resolve));
  }
});
