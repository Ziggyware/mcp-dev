import assert from "node:assert/strict";
import test from "node:test";
import { createKeyDecoder, decodeModifiers, describeEvent } from "../src/keys.js";

function names(decoder, chunk) {
  return decoder.push(chunk).map((event) => describeEvent(event));
}

test("decodes the control characters readline gets wrong or loses", () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(names(decoder, "\r"), ["enter"]);
  assert.deepEqual(names(decoder, "\n"), ["newline"]);
  assert.deepEqual(names(decoder, "\t"), ["tab"]);
  assert.deepEqual(names(decoder, "\x7f"), ["backspace"]);
  assert.deepEqual(names(decoder, "\x08"), ["ctrl+backspace"]);
  assert.deepEqual(names(decoder, "\x03"), ["ctrl+char:\"c\""]);
  assert.deepEqual(names(decoder, "\x1b[Z"), ["backtab"]);
});

test("decodes Ctrl+Enter from both kitty and modifyOtherKeys encodings", () => {
  const decoder = createKeyDecoder();
  const kitty = decoder.push("\x1b[13;5u")[0];
  assert.equal(kitty.name, "enter");
  assert.equal(kitty.ctrl, true);

  const modifyOther = decoder.push("\x1b[27;5;13~")[0];
  assert.equal(modifyOther.name, "enter");
  assert.equal(modifyOther.ctrl, true);

  const shiftEnter = decoder.push("\x1b[27;2;13~")[0];
  assert.equal(shiftEnter.name, "enter");
  assert.equal(shiftEnter.shift, true);
});

test("decodes word movement and deletion keys", () => {
  const decoder = createKeyDecoder();
  const ctrlLeft = decoder.push("\x1b[1;5D")[0];
  assert.deepEqual({ name: ctrlLeft.name, ctrl: ctrlLeft.ctrl }, { name: "left", ctrl: true });

  const altRight = decoder.push("\x1b[1;3C")[0];
  assert.deepEqual({ name: altRight.name, meta: altRight.meta }, { name: "right", meta: true });

  const altBackspace = decoder.push("\x1b\x7f")[0];
  assert.equal(altBackspace.name, "backspace");
  assert.equal(altBackspace.ctrl, true);

  assert.deepEqual(names(decoder, "\x1b[3~"), ["delete"]);
  assert.deepEqual(names(decoder, "\x1b[H"), ["home"]);
  assert.deepEqual(names(decoder, "\x1b[4~"), ["end"]);
});

test("reassembles sequences split across reads and swipes unknown CSI", () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push("\x1b["), []);
  assert.deepEqual(decoder.push("1;5"), []);
  const events = decoder.push("D");
  assert.equal(events.length, 1);
  assert.equal(describeEvent(events[0]), "ctrl+left");

  // Mouse reports and other private sequences must never leak as text.
  decoder.reset();
  assert.deepEqual(names(decoder, "\x1b[<0;10;5M"), []);
  assert.deepEqual(names(decoder, "\x1b[?1;2c"), []);
  // ...and text after them is still decoded.
  assert.deepEqual(names(decoder, "ab"), ['char:"ab"']);
});

test("flushes a lone Escape after the idle delay", () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push("\x1b"), []);
  assert.equal(decoder.pending(), true);
  const flushed = decoder.forceFlush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].name, "escape");
  assert.equal(decoder.pending(), false);
});

test("bracketed paste arrives as one event and keeps newlines", () => {
  const decoder = createKeyDecoder();
  const events = decoder.push("\x1b[200~line one\nline two\x1b[201~");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "paste");
  assert.equal(events[0].text, "line one\nline two");

  // A paste split across reads is buffered until the end marker.
  decoder.reset();
  assert.deepEqual(decoder.push("\x1b[200~half"), []);
  const rest = decoder.push(" two\x1b[201~");
  assert.equal(rest.length, 1);
  assert.equal(rest[0].text, "half two");
});

test("marks a multi-line block as a burst so its newline is not treated as Enter", () => {
  const decoder = createKeyDecoder();
  const events = decoder.push("first line\nsecond line\r");
  const enter = events.find((event) => event.name === "enter");
  assert.ok(enter);
  assert.equal(enter.burst, true);
});

test("fast typing followed by Enter in one read is still Enter, not a newline", () => {
  const decoder = createKeyDecoder();
  const events = decoder.push("abc\r");
  const enter = events.find((event) => event.name === "enter");
  assert.ok(enter);
  assert.equal(enter.burst, false, "a trailing Enter must submit the line");
  // The characters before it are still one burst of text.
  const chars = events.filter((event) => event.name === "char");
  assert.equal(chars.map((event) => event.text).join(""), "abc");
});

test("decodeModifiers maps xterm modifier parameters", () => {
  assert.deepEqual(decodeModifiers(5), { shift: false, meta: false, ctrl: true, super: false });
  assert.deepEqual(decodeModifiers(3), { shift: false, meta: true, ctrl: false, super: false });
  assert.deepEqual(decodeModifiers(1), { shift: false, meta: false, ctrl: false, super: false });
});

test("a control key right after Escape is not swallowed", () => {
  const decoder = createKeyDecoder();
  const events = decoder.push("\x1b\x04");
  assert.equal(events.length, 2);
  assert.equal(events[0].name, "escape");
  assert.equal(events[1].name, "char");
  assert.equal(events[1].ctrl, true);
  assert.equal(events[1].text, "d");
});
