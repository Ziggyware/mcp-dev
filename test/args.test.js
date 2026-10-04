import assert from "node:assert/strict";
import test from "node:test";
import { ArgumentParseError, parseCommandArguments, parseEnvAssignments, splitDelimited } from "../src/args.js";

test("parseCommandArguments preserves quoted, escaped, and empty arguments", () => {
  assert.deepEqual(
    parseCommandArguments(`one "two words" '' three\\ four 'five six'`),
    ["one", "two words", "", "three four", "five six"]
  );
});

test("parseCommandArguments rejects unfinished syntax instead of guessing", () => {
  assert.throws(() => parseCommandArguments("'missing"), ArgumentParseError);
  assert.throws(() => parseCommandArguments("trailing\\"), ArgumentParseError);
});

test("environment parsing keeps commas and equals signs inside values", () => {
  assert.deepEqual(splitDelimited(`A=one,B="two, too",C='x=y'`), ["A=one", "B=two, too", "C=x=y"]);
  assert.deepEqual(parseEnvAssignments(`A=one,B="two, too",C='x=y'`), {
    A: "one",
    B: "two, too",
    C: "x=y",
  });
  assert.throws(() => parseEnvAssignments("not-an-assignment"), ArgumentParseError);
});
