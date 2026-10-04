import assert from "node:assert/strict";
import test from "node:test";
import { listTools } from "../src/mcpClient.js";

test("listTools follows pagination and returns deterministic alphabetical order", async () => {
  const requests = [];
  const client = {
    async listTools(params) {
      requests.push(params);
      if (!params?.cursor) return { tools: [{ name: "zeta" }, { name: "alpha" }], nextCursor: "next" };
      return { tools: [{ name: "beta" }] };
    },
  };
  const tools = await listTools(client);
  assert.deepEqual(requests, [undefined, { cursor: "next" }]);
  assert.deepEqual(tools.map((tool) => tool.name), ["alpha", "beta", "zeta"]);
});

test("listTools refuses a malicious repeated cursor instead of looping forever", async () => {
  const client = { async listTools() { return { tools: [], nextCursor: "same" }; } };
  await assert.rejects(() => listTools(client), /repeated a tool-list cursor/);
});
