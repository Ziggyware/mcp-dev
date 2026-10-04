import assert from "node:assert/strict";
import test from "node:test";
import { CANCELLED, SKIP, optionItems, resolveOptionValue, summarizeArgs } from "../src/argForm.js";
import { schemaToTemplate, validateArguments } from "../src/schema.js";

test("option items mark the skip row and can lead with it", () => {
  const plain = optionItems(["fast", "slow"], { includeSkip: false });
  assert.deepEqual(plain.map((item) => item.insertText), ["fast", "slow"]);

  const skipLast = optionItems(["fast", "slow"], { includeSkip: true, skipLabel: "leave it out" });
  assert.equal(skipLast.at(-1).insertText, SKIP);
  assert.equal(skipLast.at(-1).skip, true);

  const skipFirst = optionItems(["fast", "slow"], { includeSkip: true, skipFirst: true });
  assert.equal(skipFirst[0].insertText, SKIP);
  assert.deepEqual(skipFirst.slice(1).map((item) => item.insertText), ["fast", "slow"]);
});

test("resolving a typed value prefers exact matches, then fuzzy, then raw text", () => {
  const items = optionItems(["fast", "slow"], { includeSkip: true, skipFirst: true });
  assert.equal(resolveOptionValue(items, ""), SKIP, "empty submits the highlighted row");
  assert.equal(resolveOptionValue(items, "slow"), "slow");
  assert.equal(resolveOptionValue(items, "slo"), "slow", "abbreviations resolve through fuzzy ranking");
  assert.equal(resolveOptionValue(items, "SLO"), "slow");
  assert.equal(resolveOptionValue(items, "vvv"), "vvv", "unknown text is passed through for validation");
});

test("summaries stay one line and survive every JSON shape", () => {
  assert.equal(summarizeArgs({ text: "hi" }), "text=hi");
  assert.equal(summarizeArgs({ text: "hi", times: 2 }), "text=hi times=2");
  assert.equal(summarizeArgs({ list: [1, 2, 3] }), "list=[1,2,3]");
  assert.equal(summarizeArgs({ nested: { a: { b: 1 } } }), 'nested={"a":{"b":1}}');
  assert.ok(summarizeArgs({ text: "x".repeat(400) }).length <= 100, "long values are clipped");
  assert.equal(summarizeArgs({}), "");
});

test("schema templates produce valid starting arguments", () => {
  const schema = {
    type: "object",
    properties: {
      text: { type: "string", description: "text to echo back" },
      times: { type: "integer", minimum: 1 },
      mode: { type: "string", enum: ["fast", "slow"] },
      verbose: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      options: { type: "object", properties: { limit: { type: "number" } } },
    },
    required: ["text"],
  };
  const template = JSON.parse(schemaToTemplate(schema));
  assert.equal(template.text, "");
  assert.equal(template.mode, "fast");
  assert.equal(typeof template.verbose, "boolean");
  assert.equal("tags" in template, false, "non-required arrays are left out of the template");
  assert.equal(validateArguments(schema, { text: "hi" }).valid, true);
  assert.equal(validateArguments(schema, { text: "hi", mode: "sideways" }).valid, false);
  assert.equal(validateArguments(schema, { text: "hi", times: 0 }).valid, false);
  assert.deepEqual(CANCELLED.description, "argForm:cancelled");
});
