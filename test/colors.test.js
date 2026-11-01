import test from "node:test";
import assert from "node:assert/strict";
import { colors, getColorMode, setColorMode } from "../src/colors.js";

const originalMode = getColorMode();

test.after(() => setColorMode(originalMode));

test("the shared palette uses readable foregrounds for secondary and semantic text", () => {
  setColorMode("always");

  assert.match(colors.faint("hint"), /\x1b\[38;5;245m/);
  assert.match(colors.gray("muted"), /\x1b\[38;5;250m/);
  assert.match(colors.body("body"), /\x1b\[38;5;252m/);
  assert.match(colors.success("ready"), /\x1b\[38;5;114m/);
  assert.match(colors.accent("prompt"), /\x1b\[38;5;81m/);
  assert.doesNotMatch(colors.faint("hint"), /\x1b\[2m/);
});

test("basic color mode uses bright standard foregrounds without 256-color or dim attributes", () => {
  setColorMode("basic");

  assert.match(colors.faint("hint"), /\x1b\[37m/);
  assert.match(colors.success("ready"), /\x1b\[92m/);
  assert.match(colors.warning("careful"), /\x1b\[93m/);
  assert.doesNotMatch(colors.faint("hint"), /38;5|\x1b\[2m/);
});

test("never mode remains plain text", () => {
  setColorMode("never");
  assert.equal(colors.faint("hint"), "hint");
  assert.equal(colors.success("ready"), "ready");
});
