import assert from "node:assert/strict";
import test from "node:test";
import {
  backspace,
  caretRowCol,
  createLine,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordAfter,
  deleteWordBefore,
  findWordAt,
  horizontalWindow,
  insertText,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  replaceRange,
  rowColToIndex,
} from "../src/lineEditor.js";

test("the cursor never leaves the buffer", () => {
  const line = createLine("hello", 2);
  assert.equal(moveLeft(createLine("hello", 0)).cursor, 0);
  assert.equal(moveRight(createLine("hello", 5)).cursor, 5);
  assert.equal(backspace(createLine("hello", 0)).text, "hello");
  assert.equal(deleteForward(createLine("hello", 5)).text, "hello");
  assert.equal(createLine("hello", 99).cursor, 5);
  assert.equal(createLine("hello", -3).cursor, 0);
});

test("word movement stops at word boundaries, not inside words", () => {
  const line = createLine("alpha beta gamma", 16);
  assert.equal(moveWordLeft(line).cursor, 11);
  assert.equal(moveWordLeft(moveWordLeft(line)).cursor, 6);
  assert.equal(moveWordRight(createLine("alpha beta", 0)).cursor, 5);
  // Paths and cache references stay single words.
  const refLine = createLine("read !7.rows[0].name now");
  assert.equal(refLine.text.length, 24);
  assert.equal(moveWordLeft(refLine).cursor, 21);
  assert.equal(moveWordLeft(moveWordLeft(refLine)).cursor, 5);
  assert.equal(moveWordRight(createLine("read !7.rows[0].name now", 5)).cursor, 20);
  assert.deepEqual(findWordAt("alpha beta", 8), { start: 6, end: 10, word: "beta" });
});

test("word deletion matches the boundaries word movement uses", () => {
  assert.equal(deleteWordBefore(createLine("alpha beta", 10)).text, "alpha ");
  assert.equal(deleteWordBefore(createLine("alpha beta", 10)).cursor, 6);
  assert.equal(deleteWordAfter(createLine("alpha beta", 5)).text, "alpha");
  assert.equal(deleteWordAfter(createLine("alpha beta", 0)).text, " beta");
  assert.equal(deleteToLineStart(createLine("one two", 3)).text, " two");
  assert.equal(deleteToLineEnd(createLine("one two", 3)).text, "one");
});

test("multi-line editing tracks rows and columns", () => {
  const line = createLine("first\nsecond\nthird", 8);
  assert.deepEqual(caretRowCol(line.text, line.cursor), { row: 1, col: 2 });
  assert.equal(rowColToIndex(line.text, 1, 2), 8);
  assert.equal(moveLineStart(line).cursor, 6);
  assert.equal(moveLineEnd(line).cursor, 12);
  assert.equal(moveVertical(line, -1).cursor, 2);
  assert.equal(moveVertical(line, 1).cursor, 15);
  // Vertical movement keeps the preferred column, clamped per line.
  assert.equal(moveVertical(createLine("abcdefgh\nxy", 8), 1).cursor, 11);
});

test("insert and replace keep the caret after the inserted text", () => {
  const line = insertText(createLine("ad", 1), "bc");
  assert.deepEqual(line, { text: "abcd", cursor: 3 });
  assert.deepEqual(replaceRange(createLine("/ser", 4), 0, 4, "/servers"), { text: "/servers", cursor: 8 });
});

test("horizontal window keeps the caret visible on long lines", () => {
  const text = "0123456789".repeat(5);
  const window = horizontalWindow(text, 40, 20);
  assert.equal(window.text.length, 20);
  assert.ok(window.caret >= 0 && window.caret <= 20);
  assert.ok(window.hiddenLeft > 0);

  const start = horizontalWindow(text, 0, 20);
  assert.equal(start.text, text.slice(0, 20));
  assert.equal(start.caret, 0);
  assert.equal(start.hiddenLeft, 0);
});
