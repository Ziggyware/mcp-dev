import assert from "node:assert/strict";
import test from "node:test";
import { backrefRoot, cacheEntryPaths, cachedRefItems, describeCachedPath, formatPathSegment } from "../src/backrefs.js";
import { ResultBuffer } from "../src/resultBuffer.js";

function bufferWith(text) {
  const buffer = new ResultBuffer();
  buffer.push({ server: "demo", tool: "lookup", args: {}, mcpResult: { content: [{ type: "text", text }] } });
  return buffer;
}

test("cached paths are enumerated with safe segment formatting", () => {
  const buffer = bufferWith(JSON.stringify({ "key.with.dots": [{ id: 1 }], rows: [{ name: "first" }] }));
  const entry = buffer.last();
  const paths = cacheEntryPaths(entry);
  assert.ok(paths.includes(""));
  assert.ok(paths.includes(".rows"));
  assert.ok(paths.includes(".rows[0].name"));
  assert.ok(paths.includes('["key.with.dots"][0].id'));
  assert.equal(formatPathSegment("plain"), ".plain");
  assert.equal(formatPathSegment("with.dots"), '["with.dots"]');
  assert.equal(formatPathSegment(2), "[2]");
});

test("cached references complete with value previews", () => {
  const buffer = bufferWith(JSON.stringify({ rows: [{ id: 7, name: "seven" }] }));
  const items = cachedRefItems(buffer, "!1.rows");
  const labels = items.map((item) => item.label);
  assert.ok(labels.includes("!1.rows"));
  assert.ok(labels.includes("!1.rows[0].id"));
  const idItem = items.find((item) => item.label === "!1.rows[0].id");
  assert.match(idItem.description, /7/);
  assert.equal(describeCachedPath(buffer.last(), ".rows[0].name"), 'string "seven"');
  assert.deepEqual(backrefRoot("!1.rows[0]").base, "!1");
});

test("plain-text results still offer the whole-result reference", () => {
  const buffer = bufferWith("not json at all");
  const labels = cachedRefItems(buffer, "!").map((item) => item.label);
  assert.ok(labels.includes("!1"));
  assert.ok(labels.includes("!!"));
});
