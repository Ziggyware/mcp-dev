// End-to-end keyboard tests for the interactive session.
//
// The session UI owns raw mode, the key decoder, and its own renderer, so unit
// tests alone cannot catch "the input got stuck" regressions. These tests drive
// a real pseudo-terminal (via `script`) with real key sequences and wait for
// the UI to reach each state before sending the next keystroke. The pty helper
// also keeps an emulated screen, which is what lets the tests below assert on
// things the byte stream cannot express — where the caret is, and whether a
// result survived the next repaint.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { driveSession, hasScript, makeConfigDir } from "./helpers/pty-session.js";

test("session: connect, guided call, remembered grant, inline args, cached results", { skip: !hasScript, timeout: 90_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, visible } = await driveSession([
      { wait: /Type a sentence/, send: "/demo/" },
      { wait: /❯ \/demo\//, send: "\r" },
      { wait: /demo — 4 tools/, send: "echo" },
      { wait: /❯ tool echo/, send: "\r" },
      { wait: /\[1\/2\] text required/, send: "hi" },
      { wait: /❯ text hi/, send: "\r" },
      { wait: /\[2\/2\] times optional/, send: "\r" },
      { wait: /about to call demo\/echo/, send: "a" },
      { wait: /cached as #1/, send: "/demo/echo {\"text\":\"again\"}" },
      { wait: /❯ \/demo\/echo/, send: "\r" },
      { wait: /\[1\/2\] text required/, send: "\r" },
      { wait: /\[2\/2\] times optional/, send: "\r" },
      { wait: /cached as #2/, send: "\u0003" },
      { wait: /press Ctrl\+C again to exit/, send: "\u0003" },
      { wait: /session closed/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" } });

    assert.equal(code, 0, visible.slice(-2000));
    assert.match(visible, /✓ demo\/echo text=hi/);
    assert.match(visible, /again/, "the inline-args call prints its result");
    assert.match(visible, /about to call demo\/echo/, "the approval screen appears for the first call");
    assert.match(visible, /auto-approved by a session grant/, "the remembered grant skips the second approval");
    assert.match(visible, /Enter on empty skips/, "optional fields advertise how to skip them");
    assert.match(visible, /Ctrl\+Enter newline/, "the prompt footer teaches the newline key");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("session: Escape clears the line, typing still works, Ctrl+D exits", { skip: !hasScript, timeout: 60_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, visible } = await driveSession([
      { wait: /Type a sentence/, send: "draft text" },
      { wait: /❯ draft text/, send: "\u001b" },
      { wait: /Input cleared/, send: "still typing" },
      { wait: /❯ still typing/, send: "\u001b" },
      { wait: /Input cleared/, send: "\u0004" },
      { wait: /session closed/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir } });

    assert.equal(code, 0, visible.slice(-2000));
    assert.match(visible, /Input cleared/);
    assert.match(visible, /❯ still typing/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("session: /help opens the guide, the transcript scrolls, and the prompt stays usable", { skip: !hasScript, timeout: 60_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, visible, term } = await driveSession([
      { wait: /Type a sentence/, send: "/help" },
      { wait: /❯ \/help/, send: "\r" },
      // The guide is longer than the screen: it opens at its first line, and
      // the status bar says how much is below.
      { waitScreen: (term, screen) => screen.includes("input guide") && /\u2193 \d+ more \(PgDn\)/.test(screen), send: "\u001b[1;5F" },
      // Ctrl+End jumps to the newest output: the end of the command table.
      { waitScreen: /close every connection/, send: "\u001b[5~" },
      // PgUp scrolls back towards the beginning.
      { waitScreen: /\u2193 \d+ more \(PgDn\)/, send: "\u001b[1;5F" },
      // Ctrl+End returns to the tail, where the input line is usable again.
      { waitScreen: /close every connection/, send: "/exit" },
      { wait: /❯ \/exit/, send: "\r" },
      { wait: /session closed/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" } });

    assert.equal(code, 0, visible.slice(-2000));
    assert.match(visible, /Ctrl\+Enter/);
    assert.match(visible, /input guide/);
    assert.match(visible, /close every connection/, "the guide's command table is reachable with Ctrl+End");
    assert.doesNotMatch(visible, /Set ANTHROPIC_API_KEY to use chat/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("session: the caret sits on the input row and a finished result is never painted over", { skip: !hasScript, timeout: 90_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, snapshots, visible } = await driveSession([
      { waitScreen: /Type a sentence/, send: "/demo/" },
      { waitScreen: /❯ \/demo\//, send: "\r" },
      { waitScreen: /demo — 4 tools/, send: "echo" },
      { waitScreen: /❯ tool echo/, send: "\r" },
      { waitScreen: /\[1\/2\] text required/, send: "hi" },
      { waitScreen: /❯ text hi/, send: "\r" },
      { waitScreen: /\[2\/2\] times optional/, send: "\r" },
      { waitScreen: /about to call demo\/echo/, send: "a" },
      { waitScreen: /cached as #1/, send: "typed after the result" },
      { waitScreen: /❯ typed after the result/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" } });

    assert.equal(code, 0, visible.slice(-2000));

    // The assertions below describe the live screen, which is the last snapshot
    // the driver took while the session was still painting (leaving the session
    // switches the terminal back to the normal buffer).
    const last = snapshots.at(-1);
    const screen = last.screen;
    const rows = screen.split("\n");

    // 1. The caret is on the input line, at the end of what was typed — not on
    //    the first row of the frame.
    const inputRow = rows[last.cursor.row] ?? "";
    assert.match(inputRow, /❯ typed after the result/, `caret row was "${inputRow}"`);
    assert.equal(last.cursor.col, 2 + "typed after the result".length, "the caret sits after the typed text");

    // 2. The finished tool call is still on screen: typing must not repaint
    //    over the values that were just printed.
    assert.match(screen, /cached as #1/);
    assert.match(screen, /✓ demo\/echo text=hi/);
    assert.match(screen, /^hi$/m, "the tool's output line is still visible");
    assert.ok(last.cursor.row > 5, "the caret is near the bottom of the screen, not on row 0");

    // 3. Every command that was run is still in the transcript, in order.
    const order = ["❯ /demo/", "❯ tool echo", "❯ text hi", "cached as #1", "❯ typed after the result"];
    let cursor = -1;
    for (const marker of order) {
      const at = screen.indexOf(marker, cursor + 1);
      assert.ok(at > cursor, `"${marker}" is missing or out of order on screen:\n${screen}`);
      cursor = at;
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
