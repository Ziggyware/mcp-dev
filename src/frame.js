// src/frame.js
//
// Inline frame renderer. The session UI always draws at the bottom of the
// scrollback, replacing its own previous frame, so interactive prompts feel
// like a native terminal app without ever taking over the whole screen.

import { clipText, visibleWidth } from "./terminal.js";

export class InlineFrame {
  constructor(output = process.stdout) {
    this.output = output;
    this.height = 0;
  }

  /** Content width, leaving the last column free so terminals never wrap. */
  get width() {
    const columns = Number(this.output.columns);
    return Math.max(24, (Number.isFinite(columns) && columns > 0 ? columns : 80) - 1);
  }

  /** Erase everything the frame owns and leave the cursor at its top row. */
  erase() {
    if (this.height <= 0) return;
    const up = this.height - 1;
    this.output.write(`\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[0J`);
    this.height = 0;
  }

  /**
   * Replace the frame with `lines`. `caret` is `{row, col}` in visible
   * columns; the cursor is hidden while drawing to avoid flicker.
   */
  render(lines, caret = null) {
    const width = this.width;
    const rendered = (Array.isArray(lines) ? lines : [lines]).map((line) => clipText(String(line ?? ""), width));
    const buffer = [];
    if (this.height > 0) buffer.push(`\r\x1b[${this.height - 1}A`);
    for (let index = 0; index < rendered.length; index++) {
      buffer.push("\x1b[2K", rendered[index]);
      if (index < rendered.length - 1) buffer.push("\r\n");
    }
    buffer.push("\x1b[0J");
    if (caret && rendered.length > 0) {
      const row = Math.max(0, Math.min(caret.row, rendered.length - 1));
      const up = rendered.length - 1 - row;
      if (up > 0) buffer.push(`\x1b[${up}A`);
      buffer.push("\r");
      if (caret.col > 0) buffer.push(`\x1b[${Math.min(caret.col, width)}C`);
    }
    buffer.push("\x1b[?25h");
    this.output.write(`\x1b[?25l${buffer.join("")}`);
    this.height = rendered.length;
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
