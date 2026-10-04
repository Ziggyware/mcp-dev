import assert from "node:assert/strict";
import test from "node:test";
import { ResultBuffer, parsePath, resolveBackref, walkPath } from "../src/resultBuffer.js";

test("path parser supports quoted object keys, indices, negatives, and wildcards", () => {
  const value = {
    "key.with.dots": [{ id: 1 }, { id: 2 }],
    rows: [{ name: "first" }, { name: "last" }],
  };
  assert.deepEqual(parsePath('["key.with.dots"][0].id'), [
    { type: "key", name: "key.with.dots" },
    { type: "index", value: 0 },
    { type: "key", name: "id" },
  ]);
  assert.equal(walkPath(value, '["key.with.dots"][0].id'), 1);
  assert.equal(walkPath(value, "rows[-1].name"), "last");
  assert.deepEqual(walkPath(value, "rows[*].name"), ["first", "last"]);
});

test("backrefs accept bracket paths and a literal escaped exclamation mark", () => {
  const buffer = new ResultBuffer();
  buffer.push({
    server: "example",
    tool: "lookup",
    args: {},
    mcpResult: { content: [{ type: "text", text: JSON.stringify({ "key.with.dots": ["ok"] }) }] },
  });

  assert.equal(resolveBackref('!1["key.with.dots"][0]', buffer).value, "ok");
  assert.deepEqual(resolveBackref("\\!123", buffer), { matched: false, literal: "!123" });
  buffer.clear();
  assert.equal(buffer.last(), undefined);
  const index = buffer.push({ server: "example", tool: "next", args: {}, mcpResult: { content: [] } });
  assert.equal(index, 1);
});
