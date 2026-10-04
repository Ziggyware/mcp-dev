import assert from "node:assert/strict";
import test from "node:test";
import { colorizeJsonLine, colorizeJsonText, formatJsonValue, jsonTypeLabel, parseJsonText } from "../src/jsonText.js";
import { schemaToTemplate, summarizeJson, validateArguments, isPathField } from "../src/schema.js";

test("parseJsonText reports the line and column of structural errors", () => {
  const cases = [
    ["{\n  \"a\": 1,\n  \"b\": }\n", 2, 7, /Unexpected token '}'/],
    ["{a:1}", 0, 1, /double-quoted property name/],
    ["{\"a\":1,}", 0, 7, /Trailing comma/],
    ["[1,2", 0, 4, /to close the array/],
    ["{\"a\" 1}", 0, 5, /Expected ":"/],
    ["\"oops", 0, 0, /Unterminated string/],
    ["1 2", 0, 2, /trailing characters/],
  ];
  for (const [text, line, column, pattern] of cases) {
    const result = parseJsonText(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.line, line, `${text} line`);
    assert.equal(result.column, column, `${text} column`);
    assert.match(result.error, pattern);
  }
  assert.deepEqual(parseJsonText("{\"a\": [1, true, null]}").value, { a: [1, true, null] });
  assert.equal(parseJsonText("").ok, false);
});

test("colourising never changes the visible characters", () => {
  const text = "{\n  \"key\": \"value\",\n  \"n\": 12.5,\n  \"ok\": true\n}";
  const colored = colorizeJsonText(text).join("\n");
  // eslint-disable-next-line no-control-regex
  assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, ""), text);
  // Strings that continue across lines keep colour state: the second line has
  // no opening quote, only the closing one.
  const first = colorizeJsonLine("  \"note\": \"line one", false);
  assert.equal(first.state, true);
  const continued = colorizeJsonLine("line two\",", true);
  assert.equal(continued.text.replace(/\x1b\[[0-9;]*m/g, ""), "line two\",");
  assert.equal(continued.state, false);
  const again = colorizeJsonText("{\n  \"n\": \"first\nsecond\"\n}");
  assert.equal(again[1].replace(/\x1b\[[0-9;]*m/g, ""), '  "n": "first');
  assert.equal(again[2].replace(/\x1b\[[0-9;]*m/g, ""), 'second"');
});

test("formatJsonValue truncates long strings and survives cycles", () => {
  const value = { big: "x".repeat(500), small: "ok" };
  const formatted = formatJsonValue(value, { maxString: 20 });
  assert.match(formatted, /x{19}…/);
  assert.equal(jsonTypeLabel([1, 2]), "array(2)");
  assert.equal(jsonTypeLabel(null), "null");
  const cycle = {};
  cycle.self = cycle;
  assert.match(formatJsonValue(cycle), /circular/);
});

test("schema helpers generate usable templates and flag path fields", () => {
  const template = schemaToTemplate({
    type: "object",
    properties: {
      path: { type: "string" },
      mode: { type: "string", enum: ["fast", "slow"] },
      limit: { type: "number" },
      nested: { type: "object", properties: { deep: { type: "string" } } },
    },
    required: ["path"],
  });
  assert.deepEqual(JSON.parse(template), { path: "", mode: "fast", limit: 0 });

  assert.deepEqual(validateArguments({ type: "object", properties: { n: { type: "integer", minimum: 2 } }, required: ["n"] }, { n: 1 }).valid, false);
  assert.equal(isPathField("path", {}), true);
  assert.equal(isPathField("target_file", {}), true);
  assert.equal(isPathField("query", {}), false);
  assert.equal(summarizeJson({ a: 1 }), '{"a":1}');
});
