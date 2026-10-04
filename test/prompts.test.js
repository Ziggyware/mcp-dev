import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import * as readline from "node:readline";
import { deleteWordBeforeCursor, isWordDeleteKey, textInput } from "../src/prompts.js";

function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (value) => { input.isRaw = value; };
  readline.emitKeypressEvents(input);

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  return { input, output };
}

test("deleteWordBeforeCursor removes whitespace and the adjacent word", () => {
  assert.deepEqual(deleteWordBeforeCursor("alpha beta", 10), { line: "alpha ", cursor: 6 });
  assert.deepEqual(deleteWordBeforeCursor("alpha /beta", 11), { line: "alpha /", cursor: 7 });
  assert.deepEqual(deleteWordBeforeCursor("alpha  ", 7), { line: "", cursor: 0 });
});

test("recognizes Ctrl+Backspace, Option/Alt+Backspace, and Ctrl+W", () => {
  assert.equal(isWordDeleteKey({ name: "backspace", ctrl: true, meta: false }), true);
  assert.equal(isWordDeleteKey({ name: "backspace", ctrl: false, meta: true }), true);
  assert.equal(isWordDeleteKey({ name: "w", ctrl: true, meta: false }), true);
  assert.equal(isWordDeleteKey({ name: "backspace", ctrl: false, meta: false }), false);
});

test("textInput applies word deletion before accepting input", async () => {
  const { input, output } = fakeTerminal();
  const answer = textInput({ message: "Value:" }, { input, output });
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("hello world");
  input.write("\x1b\x7f"); // Meta+Backspace, emitted by many Alt/Option terminals.
  input.write("there\r");
  assert.equal(await answer, "hello there");
});
