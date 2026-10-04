import assert from "node:assert/strict";
import test from "node:test";
import { runStep, validateArguments } from "../src/suggest.js";

test("validateArguments reports schema failures before a tool call", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer", minimum: 1 } },
    required: ["count"],
    additionalProperties: false,
  };
  assert.deepEqual(validateArguments(schema, { count: 2 }), { valid: true, errors: [] });
  const invalid = validateArguments(schema, { count: 0 });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), />= 1/);
});

test("agent dispatch uses the original server and tool names, not a namespace encoding", async () => {
  const calls = [];
  const results = await runStep(
    [{ id: "use-1", name: "mcp_tool_1", input: { path: "a.txt" } }],
    new Map([["mcp_tool_1", { __server: "server__with_separator", name: "tool__with_separator" }]]),
    async (server, tool, args) => {
      calls.push({ phase: "confirm", server, tool, args });
      return true;
    },
    async (server, tool, args) => {
      calls.push({ phase: "execute", server, tool, args });
      return { content: [{ type: "text", text: "done" }] };
    }
  );

  assert.deepEqual(calls, [
    { phase: "confirm", server: "server__with_separator", tool: "tool__with_separator", args: { path: "a.txt" } },
    { phase: "execute", server: "server__with_separator", tool: "tool__with_separator", args: { path: "a.txt" } },
  ]);
  assert.deepEqual(results, [{ type: "tool_result", tool_use_id: "use-1", content: "done", is_error: false }]);
});
