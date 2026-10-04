// src/jsonText.js
//
// JSON helpers for the inline editor: a small tokenizer (so JSON is coloured
// while it is being typed, not only after it parses), a structured parse error
// with line/column information, and value formatting used by the approval
// screen.

import { colors } from "./colors.js";

const STRING_COLOR = (s) => colors.green(s);
const NUMBER_COLOR = (s) => colors.yellow(s);
const KEYWORD_COLOR = (s) => colors.magenta(s);
const PUNCT_COLOR = (s) => colors.gray(s);
const KEY_COLOR = (s) => colors.cyan(s);

/**
 * Tokenize a single JSON line. `startState` carries over whether the previous
 * line ended inside a string, so multi-line strings still colour correctly.
 *
 * @returns {{text:string, state:boolean}}
 */
export function colorizeJsonLine(line, startState = false) {
  const source = String(line ?? "");
  let out = "";
  let index = 0;
  let inString = Boolean(startState);

  if (inString) {
    const close = findStringEnd(source, 0);
    const raw = source.slice(0, close.end);
    const after = source.slice(close.end).match(/^\s*:/);
    out += after ? KEY_COLOR(raw) : STRING_COLOR(raw);
    inString = !close.closed;
    if (inString) return { text: out, state: true };
    index = close.end;
  }

  while (index < source.length) {
    const ch = source[index];
    if (ch === '"') {
      const close = findStringEnd(source, index + 1);
      const raw = source.slice(index, close.end);
      const after = source.slice(close.end).match(/^\s*:/);
      out += after ? KEY_COLOR(raw) : STRING_COLOR(raw);
      inString = !close.closed;
      index = close.end;
      if (inString) return { text: out, state: true };
      continue;
    }
    if (/[-\d]/.test(ch) && /(^|[\[\{,:\s])$/.test(source.slice(0, index))) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
      if (match) {
        out += NUMBER_COLOR(match[0]);
        index += match[0].length;
        continue;
      }
    }
    if (source.startsWith("true", index) || source.startsWith("false", index)) {
      const word = source.startsWith("true", index) ? "true" : "false";
      out += KEYWORD_COLOR(word);
      index += word.length;
      continue;
    }
    if (source.startsWith("null", index)) {
      out += KEYWORD_COLOR("null");
      index += 4;
      continue;
    }
    if (/[\[\]{}:,]/.test(ch)) {
      out += PUNCT_COLOR(ch);
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return { text: out, state: inString };
}

function findStringEnd(source, from) {
  let index = from;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === '"') return { end: index + 1, closed: true };
    index += 1;
  }
  return { end: source.length, closed: false };
}

/** Colour a complete JSON document, line by line. */
export function colorizeJsonText(text) {
  let state = false;
  return String(text ?? "").split("\n").map((line) => {
    const result = colorizeJsonLine(line, state);
    state = result.state;
    return result.text;
  });
}

/**
 * Locate the first structural JSON error so the editor can point at the exact
 * line and column. V8's own messages no longer carry a position for several
 * common mistakes ("Unexpected token '}' ... is not valid JSON"), so a small
 * scanner fills the gap; JSON.parse still decides validity.
 */
function locateJsonError(source) {
  let index = 0;
  const length = source.length;

  const position = (at) => {
    const before = source.slice(0, Math.max(0, Math.min(at, length)));
    const rows = before.split("\n");
    return { line: rows.length - 1, column: rows[rows.length - 1].length };
  };
  const fail = (message, at = index) => {
    const error = new Error(message);
    error.jsonPosition = position(at);
    throw error;
  };
  const skip = () => { while (index < length && /\s/.test(source[index])) index += 1; };

  function parseString() {
    const start = index;
    index += 1; // opening quote
    while (index < length) {
      const ch = source[index];
      if (ch === "\\") {
        index += 2;
        continue;
      }
      if (ch === "\n" || ch === "\r") fail("Unterminated string (strings cannot contain raw newlines)", start);
      if (ch === '"') {
        index += 1;
        return;
      }
      index += 1;
    }
    fail("Unterminated string", start);
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (!match) fail("Invalid number");
    index += match[0].length;
  }

  function parseValue() {
    skip();
    if (index >= length) fail("Expected a value");
    const ch = source[index];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "t" || ch === "f") {
      const word = ch === "t" ? "true" : "false";
      if (source.startsWith(word, index)) index += word.length;
      else fail(`Unexpected token '${ch}'`);
      return;
    }
    if (ch === "n") {
      if (source.startsWith("null", index)) index += 4;
      else fail("Unexpected token 'n'");
      return;
    }
    if (/[-\d]/.test(ch)) return parseNumber();
    fail(`Unexpected token '${ch}'`);
  }

  function parseObject() {
    index += 1; // {
    skip();
    if (source[index] === "}") { index += 1; return; }
    while (index < length) {
      skip();
      if (source[index] === "}") { index += 1; return; }
      if (source[index] === '"') parseString();
      else fail("Expected a double-quoted property name");
      skip();
      if (source[index] !== ":") fail('Expected ":" after property name');
      index += 1;
      parseValue();
      skip();
      if (source[index] === ",") {
        index += 1;
        skip();
        if (source[index] === "}") fail("Trailing comma before \"}\"");
        continue;
      }
      if (source[index] === "}") { index += 1; return; }
      if (index >= length) fail('Expected "}" to close the object');
      fail('Expected "," or "}"');
    }
    fail('Expected "}" to close the object');
  }

  function parseArray() {
    index += 1; // [
    skip();
    if (source[index] === "]") { index += 1; return; }
    while (index < length) {
      skip();
      if (source[index] === "]") { index += 1; return; }
      parseValue();
      skip();
      if (source[index] === ",") {
        index += 1;
        skip();
        if (source[index] === "]") fail("Trailing comma before \"]\"");
        continue;
      }
      if (source[index] === "]") { index += 1; return; }
      if (index >= length) fail('Expected "]" to close the array');
      fail('Expected "," or "]"');
    }
    fail('Expected "]" to close the array');
  }

  try {
    parseValue();
    skip();
    if (index < length) fail("Unexpected trailing characters");
    return null;
  } catch (error) {
    return {
      message: error.message,
      line: error.jsonPosition?.line ?? 0,
      column: error.jsonPosition?.column ?? 0,
    };
  }
}

/**
 * Parse JSON and, when it fails, report the line and column so the editor can
 * point at the problem instead of printing a raw V8 message.
 */
export function parseJsonText(text) {
  const source = String(text ?? "");
  if (!source.trim()) return { ok: false, error: "JSON is empty.", line: 0, column: 0 };
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch (error) {
    const located = locateJsonError(source);
    return {
      ok: false,
      error: located?.message ?? (error.message ?? "Invalid JSON"),
      line: located?.line ?? 0,
      column: located?.column ?? 0,
    };
  }
}

export function isJsonText(text) {
  return parseJsonText(text).ok;
}

/** Pretty JSON for approval screens, with long strings truncated. */
export function formatJsonValue(value, { maxString = 160, indent = 2 } = {}) {
  const seen = new WeakSet();
  const replaced = JSON.stringify(value, function replacer(key, item) {
    if (typeof item === "string" && item.length > maxString) return `${item.slice(0, maxString - 1)}…`;
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[circular]";
      seen.add(item);
    }
    return item;
  }, indent);
  return replaced ?? String(value);
}

export function jsonValueSummary(value, maxLength = 48) {
  if (value === undefined) return "undefined";
  let text;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function jsonTypeLabel(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length})`;
  return typeof value;
}
