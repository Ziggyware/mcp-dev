// Screen-level regression tests for the interactive session.
//
// These cover the complaints that the pty stream alone cannot express:
//
//   * the caret belongs on the input row, not on the first row of the frame,
//   * choosing a different menu item must not shift the screen upwards,
//   * one Tab accepts the highlighted completion and one Enter runs it,
//   * a finished result stays readable while the next command is typed,
//   * the full height of the terminal is used: status bar on top, hints at the
//     bottom, transcript in between, with PgUp/PgDn over the whole history.
//
// The driver keeps an emulated screen (./helpers/vterm.js), so every assertion
// below is about what a terminal would actually display.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { driveSession, hasScript, makeConfigDir } from "./helpers/pty-session.js";

const rowsOf = (snapshot) => snapshot.screen.split("\n");
const caretRow = (snapshot) => rowsOf(snapshot)[snapshot.cursor.row] ?? "";

test("session: the caret stays on the input row and the menu selection never shifts the screen", { skip: !hasScript, timeout: 90_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, snapshots, visible } = await driveSession([
      { waitScreen: /Type a sentence/, send: "/demo/" },
      { waitScreen: /❯ \/demo\//, name: "typed", send: "\r" },
      // The tool picker: boom is highlighted first.
      { waitScreen: /▸ boom/, name: "menu-open", send: "\u001b[B" },
      // One ↓ moves the marker to echo.
      { waitScreen: /▸ echo/, name: "menu-down", send: "ech" },
      { waitScreen: /❯ tool ech/, name: "filtered", send: "\t" },
      // One Tab accepts the highlighted completion (echo) without a second press.
      { waitScreen: /❯ tool echo/, name: "after-tab", send: "\r" },
      // …and one Enter runs it: the argument form opens.
      { waitScreen: /\[1\/2\] text required/, name: "after-enter", send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" }, timeoutMs: 30_000 });

    assert.equal(code, 0, visible.slice(-2000));
    const byName = Object.fromEntries(snapshots.map((snapshot) => [snapshot.name, snapshot]));

    // 1. Caret on the input row, at the end of the typed text — never on row 0.
    const typed = byName.typed;
    assert.match(caretRow(typed), /❯ \/demo\//, `caret row was "${caretRow(typed)}"`);
    assert.ok(typed.cursor.row > 5, "the caret is near the bottom of the screen, not on the first row");
    assert.equal(typed.cursor.col, 8, "the caret sits after the typed text");

    // 2. The whole height is used: status bar on row 0, hints on the last row,
    //    the input block pinned above it.
    const open = byName["menu-open"];
    const openRows = rowsOf(open);
    assert.match(openRows[0], /mcp-dev · 1 server/, "the status bar owns the first row");
    assert.match(openRows[openRows.length - 1], /Tab complete|type to filter|Enter/, "the hint line owns the last row");
    assert.ok(open.cursor.row >= 20, `the input row sits near the bottom (row ${open.cursor.row})`);
    assert.match(caretRow(open), /❯ tool/, `caret row was "${caretRow(open)}"`);

    // 3. Selecting another menu item repaints only the marker rows: nothing
    //    above the menu moves, so the screen no longer creeps upwards.
    const changed = [];
    for (let index = 0; index < Math.max(openRows.length, rowsOf(byName["menu-down"]).length); index += 1) {
      if ((openRows[index] ?? "").trimEnd() !== (rowsOf(byName["menu-down"])[index] ?? "").trimEnd()) changed.push(index);
    }
    const markerRows = changed.filter((index) => /boom|echo|list_dir|shape/.test(openRows[index] ?? ""));
    assert.deepEqual(changed, markerRows, `only the highlighted rows may change, changed: ${JSON.stringify(changed)}`);
    assert.equal(byName["menu-down"].cursor.row, open.cursor.row, "the input row does not move when the menu selection changes");

    // 4. One Tab, one Enter: the form is already open after a single press of each.
    assert.match(caretRow(byName["after-enter"]), /❯ text/, "the first field prompt is on the caret row");

    // 5. Nothing was painted over: the connection and tool list printed before
    //    the menu are still on the screen (asserted while the menu is live, since
    //    leaving the session restores the terminal's normal buffer).
    assert.match(open.screen, /✓ connecting demo/, "the connect line survived the repaints");
    assert.match(open.screen, /demo — 4 tools/, "the tool list is still readable under the prompt");
    assert.match(open.screen, /Echo the provided text/, "the menu keeps describing the highlighted tool");
    assert.match(byName["after-enter"].screen, /✓ connecting demo/, "the result is still there once the form opened");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("session: a long result stays readable and the transcript scrolls over it", { skip: !hasScript, timeout: 90_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, snapshots, visible } = await driveSession([
      // Print a result longer than the transcript viewport.
      { waitScreen: /Type a sentence/, send: "/help" },
      { waitScreen: /❯ \/help/, send: "\r" },
      // The guide opens at its first line and says how much is below.
      { waitScreen: /input guide/, name: "guide-open", send: "/" },
      { waitScreen: (t) => /^\s*❯ \//.test(t.line(t.row)), name: "typing-after-help", send: "\u001b[1;5F" },
      // Ctrl+End jumps to the newest output: the end of the command table.
      { waitScreen: /close every connection/, name: "guide-tail", send: "\u001b[5~" },
      // PgUp scrolls back a page: the status bar reports what is below.
      { waitScreen: /\u2193 \d+ more \(PgDn\)/, name: "scrolled", send: "\u001b[1;5F" },
      { waitScreen: /close every connection/, name: "back-at-tail", send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" }, timeoutMs: 30_000 });

    assert.equal(code, 0, visible.slice(-2000));
    const byName = Object.fromEntries(snapshots.map((snapshot) => [snapshot.name, snapshot]));

    // The typed command survived a screenful of output: the input row is live
    // with the "/" the user typed while the guide was on screen.
    assert.match(caretRow(byName["typing-after-help"]), /^\s*❯ \//);

    // Scrolling is real: the tail of the guide is reachable by key, and the
    // status bar tells the user how far up they are.
    assert.match(byName["guide-tail"].screen, /close every connection/);
    assert.match(byName["scrolled"].screen, /\u2193 \d+ more \(PgDn\)/);
    assert.doesNotMatch(byName["scrolled"].screen, /close every connection/);
    assert.match(byName["back-at-tail"].screen, /close every connection/);

    // The prompt is still pinned at the bottom in every one of those states.
    for (const name of ["guide-open", "scrolled", "back-at-tail"]) {
      assert.match(caretRow(byName[name]), /❯/, `the caret left the input row while ${name}`);
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("session: Escape cancels a dialog and a quick double Ctrl+C still leaves", { skip: !hasScript, timeout: 60_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, visible } = await driveSession([
      { waitScreen: /Type a sentence/, send: "/demo/" },
      { waitScreen: /❯ \/demo\//, send: "\r" },
      // The tool picker advertises "Esc cancel" — one press closes it.
      { waitScreen: /▸ boom/, send: "\u001b" },
      { waitScreen: (t) => /^\s*❯\s*$/.test(t.line(t.row)) && !/type to filter/.test(t.text()), send: "\u0003" },
      { wait: /press Ctrl\+C again to exit/, send: "\u0003" },
      { wait: /session closed/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" }, timeoutMs: 25_000 });

    assert.equal(code, 0, visible.slice(-2000));
    assert.match(visible, /press Ctrl\+C again to exit/);
    assert.match(visible, /session closed/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
