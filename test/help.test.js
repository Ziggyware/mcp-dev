import assert from "node:assert/strict";
import test from "node:test";
import { fastHelpRequest, renderHelp, VERSION } from "../src/help.js";

test("fast help recognizes root, command, and version paths", () => {
  assert.deepEqual(fastHelpRequest([]), { type: "help", topic: null });
  assert.deepEqual(fastHelpRequest(["tools", "--help"]), { type: "help", topic: "tools" });
  assert.deepEqual(fastHelpRequest(["--version"]), { type: "version" });
  assert.equal(typeof VERSION, "string");
});

test("focused help includes actionable options and keyboard support", () => {
  const text = renderHelp("call", { width: 72 });
  assert.match(text, /--dry-run/);
  assert.match(text, /--args-file/);
  assert.match(text, /Ctrl\+Backspace/);
});
