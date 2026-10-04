/**
 * A small editor model for the interactive prompt.
 *
 * The model is intentionally free of terminal concerns: it is just text plus a
 * cursor position (as a code-unit index), plus the operations a user expects
 * from a modern line editor (word movement, word deletion, multi-line caret
 * arithmetic for "\n"-containing input).
 *
 * Word characters include the punctuation that shows up in this CLI's own
 * grammar — `/server/tool` routes, `!7.rows[0].name` cache references, and
 * `flag=value` arguments are each a single word — so Ctrl+Left/Right walks
 * over them instead of stopping inside them.
 */

const WORD_CHAR = /[\p{L}\p{N}_!./~\-[\]]/u;

export function isWordChar(char) {
  return Boolean(char) && WORD_CHAR.test(char);
}

export function createLine(text = "", cursor = text.length) {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  return { text: safeText, cursor: Math.max(0, Math.min(cursor, safeText.length)) };
}

function textOf(value) {
  return typeof value === "string" ? value : String(value?.text ?? "");
}

function at(text, index) {
  return index >= 0 && index < text.length ? text[index] : "";
}

function wordStartBefore(text, index) {
  let cursor = index;
  while (cursor > 0 && !isWordChar(at(text, cursor - 1))) cursor -= 1;
  while (cursor > 0 && isWordChar(at(text, cursor - 1))) cursor -= 1;
  return cursor;
}

function wordEndAfter(text, index) {
  let cursor = index;
  while (cursor < text.length && !isWordChar(at(text, cursor))) cursor += 1;
  while (cursor < text.length && isWordChar(at(text, cursor))) cursor += 1;
  return cursor;
}

export function moveLeft(line) {
  return createLine(line.text, Math.max(0, line.cursor - 1));
}

export function moveRight(line) {
  return createLine(line.text, Math.min(line.text.length, line.cursor + 1));
}

export function moveWordLeft(line) {
  return createLine(line.text, wordStartBefore(line.text, line.cursor));
}

export function moveWordRight(line) {
  return createLine(line.text, wordEndAfter(line.text, line.cursor));
}

/** Index where the caret's line begins. */
export function lineStartIndex(text, cursor) {
  return text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

/** Index of the newline (or end of text) that terminates the caret's line. */
export function lineEndIndex(text, cursor) {
  const index = text.indexOf("\n", cursor);
  return index === -1 ? text.length : index;
}

export function moveLineStart(line) {
  return createLine(line.text, lineStartIndex(line.text, line.cursor));
}

export function moveLineEnd(line) {
  return createLine(line.text, lineEndIndex(line.text, line.cursor));
}

export function insertText(line, text) {
  const value = String(text ?? "");
  const next = line.text.slice(0, line.cursor) + value + line.text.slice(line.cursor);
  return createLine(next, line.cursor + value.length);
}

/** Replace `[start, end)` with `text`, leaving the caret after the insert. */
export function replaceRange(line, start, end, text) {
  const value = String(text ?? "");
  const from = Math.max(0, Math.min(start, line.text.length));
  const to = Math.max(from, Math.min(end, line.text.length));
  const next = line.text.slice(0, from) + value + line.text.slice(to);
  return createLine(next, from + value.length);
}

export function backspace(line) {
  if (line.cursor === 0) return line;
  return createLine(line.text.slice(0, line.cursor - 1) + line.text.slice(line.cursor), line.cursor - 1);
}

export function deleteForward(line) {
  if (line.cursor >= line.text.length) return line;
  return createLine(line.text.slice(0, line.cursor) + line.text.slice(line.cursor + 1), line.cursor);
}

export function deleteWordBefore(line) {
  if (line.cursor === 0) return line;
  const start = wordStartBefore(line.text, line.cursor);
  return createLine(line.text.slice(0, start) + line.text.slice(line.cursor), start);
}

export function deleteWordAfter(line) {
  if (line.cursor >= line.text.length) return line;
  const end = wordEndAfter(line.text, line.cursor);
  return createLine(line.text.slice(0, line.cursor) + line.text.slice(end), line.cursor);
}

export function deleteToLineStart(line) {
  return replaceRange(line, lineStartIndex(line.text, line.cursor), line.cursor, "");
}

export function deleteToLineEnd(line) {
  return replaceRange(line, line.cursor, lineEndIndex(line.text, line.cursor), "");
}

/** Caret row/column for a possibly multi-line value. */
export function caretRowCol(textOrLine, cursorArg = undefined) {
  const text = textOf(textOrLine);
  const cursor = typeof textOrLine === "object" && textOrLine !== null && textOrLine.text !== undefined
    ? textOrLine.cursor
    : Math.max(0, Math.min(cursorArg ?? text.length, text.length));
  const before = text.slice(0, cursor);
  const row = (before.match(/\n/g) ?? []).length;
  const column = cursor - (before.lastIndexOf("\n") + 1);
  return { row, col: column };
}

export function rowColToIndex(text, row, column) {
  const rows = String(text).split("\n");
  if (row >= rows.length) return String(text).length;
  let index = 0;
  for (let i = 0; i < Math.max(0, row); i += 1) index += rows[i].length + 1;
  return Math.min(index + Math.max(0, column), index + rows[Math.max(0, row)].length);
}

/** Move the caret `delta` rows, clamping to each line's length. */
export function moveVertical(line, delta) {
  const { row, col } = caretRowCol(line.text, line.cursor);
  const rows = line.text.split("\n");
  const target = Math.max(0, Math.min(rows.length - 1, row + delta));
  if (target === row) return line;
  return createLine(line.text, rowColToIndex(line.text, target, col));
}

export function moveUp(line) {
  return moveVertical(line, -1);
}

export function moveDown(line) {
  return moveVertical(line, 1);
}

/** The word (or whitespace run) around `index`, used for delete hints. */
export function findWordAt(text, index) {
  const value = String(text ?? "");
  const position = Math.max(0, Math.min(index, value.length));
  let start = position;
  let end = position;
  if (isWordChar(at(value, position))) {
    while (start > 0 && isWordChar(at(value, start - 1))) start -= 1;
    while (end < value.length && isWordChar(at(value, end))) end += 1;
  } else {
    while (start > 0 && !isWordChar(at(value, start - 1))) start -= 1;
    while (end < value.length && !isWordChar(at(value, end))) end += 1;
  }
  return { start, end, word: value.slice(start, end) };
}

/**
 * Window a single line of text so the caret stays visible within `width`
 * columns. Returns the drawn text, the caret column inside it, and how much
 * text is hidden on either side (used for the ⟩ / ⟨ indicators).
 */
export function horizontalWindow(text, cursor, width) {
  const value = String(text ?? "");
  const budget = Math.max(1, Math.floor(width));
  const position = Math.max(0, Math.min(cursor, value.length));
  if (value.length <= budget) {
    return { text: value, caret: position, hiddenLeft: 0, hiddenRight: 0 };
  }
  const half = Math.floor(budget / 2);
  const start = Math.max(0, Math.min(position - half, value.length - budget));
  const end = start + budget;
  return {
    text: value.slice(start, end),
    caret: position - start,
    hiddenLeft: start,
    hiddenRight: value.length - end,
  };
}

export function isWordDeleteKey(event) {
  if (!event) return false;
  return event.name === "backspace" && (event.ctrl === true || event.meta === true);
}

export function isLineDeleteKey(event) {
  if (!event) return false;
  return event.name === "delete" && (event.ctrl === true || event.meta === true);
}
