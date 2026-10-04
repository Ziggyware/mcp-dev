// src/frame.js
//
// Inline frame renderer for prompts that are *not* running inside the session
// screen (one-shot `mcp-dev call` flows, registration wizards). The session
// itself now renders through ./screen.js; this class stays for the plain CLI
// path, where the terminal's own scrollback must keep working.
//
// The frame always knows which row the terminal cursor is on *inside the
// frame*, not just how tall the frame is. Assuming "the cursor is on the last
// row" is what used to make the whole UI creep upwards after a menu item was
// selected — the erase pass started one row too high and left a line of the
// previous frame behind on every repaint.

import { clipText, visibleWidth } from "./terminal.js";

export class InlineFrame {
  constructor(output = process.stdout) {
    this.output = output;
    this.height = 0;
    this.cursorRow = 0;
  }

  /** Content width, leaving the last column free so terminals never wrap. */
  get width() {
    const columns = Number(this.output.columns);
    return Math.max(24, (Number.isFinite(columns) && columns > 0 ? columns : 80) - 1);
  }

  /** Maximum rows one frame may occupy, so the terminal never scrolls it away. */
  get maxHeight() {
    const rows = Number(this.output.rows);
    return Math.max(1, (Number.isFinite(rows) && rows > 0 ? rows : 40) - 1);
  }

  /** Move the terminal cursor to a row of the frame, absolutely. */
  _moveTo(row) {
    const delta = row - this.cursorRow;
    if (delta === 0) this.output.write("\r");
    else this.output.write(`\r\x1b[${Math.abs(delta)}${delta < 0 ? "A" : "B"}`);
    this.cursorRow = row;
  }

  /** Erase everything the frame owns and leave the cursor at its top row. */
  erase() {
    if (this.height <= 0) return;
    this._moveTo(0);
    this.output.write("\x1b[0J");
    this.height = 0;
    this.cursorRow = 0;
  }

  /**
   * Replace the frame with `lines`. `caret` is `{row, col}` in visible
   * columns relative to the frame; the cursor is hidden while drawing to avoid
   * flicker and left exactly on the caret afterwards.
   */
  render(lines, caret = null) {
    const width = this.width;
    const source = (Array.isArray(lines) ? lines : [lines]).map((line) => clipText(String(line ?? ""), width));
    const maxHeight = this.maxHeight;
    const dropped = Math.max(0, source.length - maxHeight);
    const rendered = dropped ? source.slice(dropped) : source;
    const adjustedCaret = caret ? { row: Math.max(0, caret.row - dropped), col: caret.col } : null;

    const buffer = ["\x1b[?25l"];
    if (this.height > 0) this._moveTo(0);
    else buffer.push("\r");
    for (let index = 0; index < rendered.length; index++) {
      buffer.push("\x1b[2K", rendered[index]);
      if (index < rendered.length - 1) buffer.push("\r\n");
    }
    buffer.push("\x1b[0J");
    this.height = rendered.length;
    this.cursorRow = Math.max(0, rendered.length - 1);
    if (adjustedCaret && rendered.length > 0) {
      const row = Math.max(0, Math.min(adjustedCaret.row, rendered.length - 1));
      const up = rendered.length - 1 - row;
      if (up > 0) buffer.push(`\x1b[${up}A`);
      buffer.push("\r");
      if (adjustedCaret.col > 0) buffer.push(`\x1b[${Math.min(adjustedCaret.col, width)}C`);
      this.cursorRow = row;
    }
    buffer.push("\x1b[?25h");
    this.output.write(buffer.join(""));
    return this;
  }

  /**
   * Erase the frame, print `text` (or several lines) permanently, and let the
   * caller draw a new frame afterwards.
   */
  println(text = "") {
    const lines = Array.isArray(text) ? text : [text];
    this.erase();
    this.output.write(`${lines.join("\n")}\n`);
  }

  /** Number of visible columns left for content. */
  static fit(value, width, ellipsis = "…") {
    return clipText(String(value ?? ""), width, ellipsis);
  }

  static width(value) {
    return visibleWidth(String(value ?? ""));
  }
}
