// src/screen.js
//
// The session's full-screen surface: a scrollable transcript on top, a status
// bar, and a pinned input block at the bottom.
//
// Why a screen and not an inline frame: the session now keeps its own history
// of every line it has printed (results included), so nothing is ever
// overwritten by a repaint and everything stays reachable with PgUp/PgDn, the
// mouse wheel, or Shift+↑/↓ — even when the terminal has no scrollback (tmux
// copy-mode, `script`, CI captures, Windows conhost without a real scrollback).
// The alternate buffer keeps the user's shell history untouched.
//
// The screen owns stdout while it is active: `capture()` redirects every write
// — including stray console.log from the MCP SDK — into the transcript, and
// `release()` puts the terminal back exactly as it was. Rendering is absolute
// (every row is redrawn from the model), which is what makes the layout
// immune to the cursor-position drift that used to shift the UI upwards.

import util from "node:util";
import { clipText, stripAnsi, visibleWidth } from "./terminal.js";
import { pushBytes } from "./typeahead.js";

const SYNC_ON = "\x1b[?2026h"; // begin synchronized update (ignored when unsupported)
const SYNC_OFF = "\x1b[?2026l";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h"; // button events + SGR coordinates
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MIN_PROMPT_ROWS = 2;
const MAX_PROMPT_SHARE = 0.62;

const ANSI_TOKEN = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\s\S]/gu;

/**
 * Wrap one logical line to `width` visible columns. ANSI sequences pass through
 * untouched, and a line that is exactly `width` wide does not produce a
 * trailing empty row.
 */
export function wrapLine(text, width) {
  const limit = Math.max(1, Math.floor(width));
  const rows = [];
  let row = "";
  let used = 0;
  for (const token of String(text ?? "").match(ANSI_TOKEN) ?? []) {
    if (token.charCodeAt(0) === 0x1b) {
      row += token;
      continue;
    }
    if (used >= limit) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += token;
    used += 1;
  }
  rows.push(row);
  return rows;
}

/** Number of rows a logical line occupies at `width`. */
export function wrappedHeight(text, width) {
  const length = visibleWidth(text);
  return Math.max(1, Math.ceil(length / Math.max(1, Math.floor(width))));
}

function isWheel(event) {
  return event?.type === "mouse" && (event.button & 64) === 64;
}

export class Screen {
  /** The screen a session prompt defaults to when the caller does not pass one. */
  static current = null;

  constructor({ input = process.stdin, output = process.stdout, maxLines = 5000, mouse = true } = {}) {
    this.input = input;
    this.output = output;
    this.maxLines = maxLines;
    this.mouse = mouse;
    this.lines = [];       // committed transcript lines (may contain ANSI)
    this.partial = "";     // current unterminated line
    this.status = "";      // left side of the status bar
    this.activity = null;  // { text, startedAt } shown on the right while busy
    this.prompt = null;    // { lines: string[], caret: {row, col} | null }
    this.scroll = 0;       // rows below the viewport (0 = following the newest line)
    this.active = false;
    this._wrapped = null;  // cache: { width, rows }
    this._write = output.write.bind(output);
    this._captured = null;
    this._onResize = () => this.render();
    this._onExit = () => this.leave();
    // The screen is the session's single stdin reader: whoever is active (a
    // prompt, a spinner) registers as the consumer, and bytes that arrive in
    // the gaps are queued as type-ahead instead of being lost in the handover.
    this._consumer = null;
    this._onData = (chunk) => this.onBytes(chunk);
    this._cursorVisible = false;
  }

  get columns() {
    const value = Number(this.output.columns);
    return Number.isFinite(value) && value > 0 ? Math.max(20, Math.floor(value)) : DEFAULT_COLUMNS;
  }

  get rows() {
    const value = Number(this.output.rows);
    return Number.isFinite(value) && value > 0 ? Math.max(4, Math.floor(value)) : DEFAULT_ROWS;
  }

  /** Content width: the last column stays free so rows never trigger a wrap. */
  get width() {
    return Math.max(19, this.columns - 1);
  }

  get height() {
    return this.rows;
  }

  /** Rows the input block may occupy before it has to drop optional sections. */
  promptBudget() {
    return Math.max(MIN_PROMPT_ROWS, Math.min(this.height - 2, Math.floor(this.height * MAX_PROMPT_SHARE)));
  }

  // ----------------------------------------------------------------- lifecycle

  enter() {
    if (this.active) return;
    this.active = true;
    Screen.current = this;
    // The session keeps the terminal in raw mode from here until it leaves.
    // Toggling it around every prompt used to hand control back to the kernel's
    // line discipline in the gaps — typed characters were echoed by the tty,
    // CR came back as LF, and fast keys were dropped.
    this.input.setRawMode?.(true);
    this._write(`${ALT_ON}\x1b[2J\x1b[H${CURSOR_HIDE}`);
    if (this.mouse) this._write(MOUSE_ON);
    this.input.resume?.();
    this.input.on("data", this._onData);
    this.output.on?.("resize", this._onResize);
    this.output.on?.("SIGWINCH", this._onResize);
    process.on?.("exit", this._onExit);
    this.render();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    if (Screen.current === this) Screen.current = null;
    this._captured?.();
    if (this.mouse) this._write(MOUSE_OFF);
    this._write(`${CURSOR_SHOW}${ALT_OFF}`);
    this.output.off?.("resize", this._onResize);
    this.output.off?.("SIGWINCH", this._onResize);
    process.off?.("exit", this._onExit);
    this.input.off?.("data", this._onData);
    this._consumer = null;
    this.input.setRawMode?.(false);
    // Stop reading: a resumed stdin keeps the event loop (and the process)
    // alive, which would turn "session closed" into a hung terminal.
    this.input.pause?.();
    this.prompt = null;
  }

  /**
   * Redirect stdout/console into the transcript until the returned function is
   * called (also called by `leave()`). This is what keeps server warnings and
   * library logs from tearing through the frame.
   */
  capture() {
    if (this._captured) return this._captured;
    const output = this.output;
    const originalWrite = output.write;
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const sink = (method) => (...args) => {
      let text;
      try {
        text = util.format(...args);
      } catch {
        text = args.map((value) => String(value)).join(" ");
      }
      this.write(`${text}\n`);
      return undefined;
    };
    output.write = (chunk, encoding, callback) => {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      try {
        this.write(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""));
      } catch {
        // Never let a rendering hiccup break the caller's write.
      }
      callback?.();
      return true;
    };
    for (const name of Object.keys(originals)) console[name] = sink(name);
    const restore = () => {
      if (this._captured !== restore) return;
      this._captured = null;
      output.write = originalWrite;
      for (const [name, fn] of Object.entries(originals)) console[name] = fn;
    };
    this._captured = restore;
    return restore;
  }

  release() {
    this._captured?.();
  }

  // -------------------------------------------------------------------- input

  /**
   * Take over stdin bytes until the returned function is called. Only one
   * consumer can be active (a prompt, or a spinner while a call runs); bytes
   * arriving with no consumer go to the type-ahead queue for the next prompt.
   */
  setInputConsumer(consume) {
    if (typeof consume !== "function") return () => {};
    this._consumer = consume;
    return () => {
      if (this._consumer === consume) this._consumer = null;
    };
  }

  /** Hand a chunk to the active consumer, or queue it as type-ahead. */
  onBytes(chunk) {
    const consumer = this._consumer;
    if (!consumer) {
      pushBytes(chunk);
      return;
    }
    consumer(chunk);
  }

  // ------------------------------------------------------------------ content

  setStatus(text) {
    this.status = String(text ?? "");
    return this;
  }

  setActivity(text, { startedAt = null } = {}) {
    this.activity = text ? { text: String(text), startedAt: startedAt ?? Date.now() } : null;
    return this;
  }

  /** Turn wheel tracking on or off; off restores native drag-to-select. */
  setMouse(on) {
    this.mouse = Boolean(on);
    if (this.active) this._write(this.mouse ? MOUSE_ON : MOUSE_OFF);
    return this;
  }

  /**
   * Set (or clear) the pinned input block: `{ lines, caret }`.
   *
   * The block's height changes what "one page" means, so a scrolled view is
   * re-anchored here: without this, the transcript appears to jump whenever a
   * menu opens or closes while the user is reading history.
   */
  setPrompt(prompt) {
    const next = prompt && Array.isArray(prompt.lines) && prompt.lines.length ? prompt : null;
    const before = this.prompt?.lines?.length ?? 0;
    const after = next?.lines?.length ?? 0;
    if (this.active && after !== before && this.scroll > 0) {
      // A taller input block shrinks the transcript viewport from the bottom,
      // so the same content needs a larger "rows from the tail" offset.
      this.scroll = Math.max(0, this.scroll + (after - before));
    }
    this.prompt = next;
    return this;
  }

  clearTranscript() {
    this.lines = [];
    this.partial = "";
    this._wrapped = null;
    this.scroll = 0;
    return this;
  }

  /** Append raw text, honoring embedded newlines and carriage returns. */
  write(chunk) {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    if (!text) return this;
    const before = this._displayRows().length;
    const normalized = text.replace(/\r\n?/g, "\n");
    const parts = normalized.split("\n");
    for (let index = 0; index < parts.length - 1; index++) {
      this.lines.push(this.partial + parts[index]);
      this.partial = "";
      if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    }
    // Keep any unterminated tail visible: some writers emit a line in pieces.
    this.partial = parts[parts.length - 1];
    if (this.partial.length > 200_000) this.partial = this.partial.slice(-200_000);
    this._wrapped = null;
    const added = Math.max(0, this._displayRows().length - before);
    if (this.scroll === 0 && added > this._transcriptHeight()) {
      // A block long enough to fill the view (a tool result, /help) reads from
      // its first line, the way a pager does; the rest stays one PgDn/Ctrl+End
      // away. Output that arrives while the reader is scrolled up never yanks
      // the view — PgDn/Ctrl+End are always one key away.
      this.scroll = Math.min(added - this._transcriptHeight(), this.maxScroll());
    }
    this.render();
    return this;
  }

  /** True when the transcript is scrolled away from the newest line. */
  get atTail() {
    return this.scroll === 0;
  }

  // ------------------------------------------------------------------ wrapping

  _displayRows() {
    if (this._wrapped && this._wrapped.width === this.width) return this._wrapped.rows;
    const rows = [];
    for (const line of this.lines) {
      const wrapped = wrapLine(line, this.width);
      for (const row of wrapped) rows.push(row);
    }
    if (this.partial) for (const row of wrapLine(this.partial, this.width)) rows.push(row);
    this._wrapped = { width: this.width, rows };
    return rows;
  }

  // ------------------------------------------------------------------ scroll

  maxScroll(rows = this._displayRows().length) {
    return Math.max(0, rows - this._transcriptHeight());
  }

  _transcriptHeight() {
    const promptRows = this.prompt?.lines?.length ?? 0;
    return Math.max(1, this.height - 1 - promptRows);
  }

  scrollBy(delta) {
    const limit = this.maxScroll();
    const next = Math.max(0, Math.min(limit, this.scroll + delta));
    if (next === this.scroll) return false;
    this.scroll = next;
    return true;
  }

  scrollToTop() {
    return this.scrollBy(this.maxScroll());
  }

  scrollToBottom() {
    if (this.scroll === 0) return false;
    this.scroll = 0;
    return true;
  }

  /**
   * Handles PgUp/PgDn, Shift+↑/↓, Home/End with Ctrl, and the mouse wheel.
   *
   * `scroll` counts the rows *below* the viewport (0 = following the newest
   * output), so moving back in history grows it and moving towards the tail
   * shrinks it. Wheel event 64/65 is up/down, i.e. `button & 1` is down.
   */
  handleKey(event) {
    if (!event) return false;
    if (isWheel(event)) {
      const lines = Math.max(1, Math.floor(this._transcriptHeight() / 3));
      return this.scrollBy(event.button & 1 ? -lines : lines);
    }
    if (event.type !== "key") return false;
    if (event.name === "pageup") return this.scrollBy(this._transcriptHeight());
    if (event.name === "pagedown") return this.scrollBy(-this._transcriptHeight());
    if (event.shift && event.name === "up") return this.scrollBy(1);
    if (event.shift && event.name === "down") return this.scrollBy(-1);
    if (event.ctrl && event.name === "home") return this.scrollToTop();
    if (event.ctrl && event.name === "end") return this.scrollToBottom();
    return false;
  }

  // ------------------------------------------------------------------ render

  /** One row of the status bar: current context on the left, busy/scroll right. */
  _statusRow() {
    // `scroll` is the number of rows below the viewport, so "more" always sits
    // under the view; while the screen follows the tail it is activity only.
    const right = this.activity
      ? this._activityText()
      : this.scroll > 0
        ? `↓ ${this.scroll} more (PgDn)`
        : "";
    const left = clipText(this.status, Math.max(0, this.width - visibleWidth(right) - 2));
    const gap = Math.max(1, this.width - visibleWidth(left) - visibleWidth(right));
    return `${left}${" ".repeat(gap)}${right}`;
  }

  _activityText() {
    const elapsed = Date.now() - (this.activity.startedAt ?? Date.now());
    const seconds = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
    return `${this.activity.text} ${seconds}`;
  }

  /** The visible transcript slice, padded at the top so the tail sits at the bottom. */
  _transcriptRows(height) {
    const rows = this._displayRows();
    const total = rows.length;
    const scroll = Math.min(this.scroll, Math.max(0, total - height));
    const start = Math.max(0, total - height - scroll);
    const slice = rows.slice(start, start + height);
    while (slice.length < height) slice.unshift("");
    return slice.map((row) => clipText(row, this.width));
  }

  compose() {
    const height = this.height;
    // Keep at least one transcript row and the status bar: the input block can
    // never swallow the whole screen, no matter how large a title grows.
    const maxPrompt = Math.max(1, height - 2);
    const promptSource = this.prompt?.lines ?? [];
    const dropped = Math.max(0, promptSource.length - maxPrompt);
    const promptLines = promptSource.slice(dropped).map((line) => clipText(String(line ?? ""), this.width));
    const transcriptHeight = Math.max(1, height - 1 - promptLines.length);
    const rows = [clipText(this._statusRow(), this.width)];
    rows.push(...this._transcriptRows(transcriptHeight));
    rows.push(...promptLines);
    let caret = null;
    if (this.prompt?.caret) {
      const promptTop = rows.length - promptLines.length;
      const row = Math.max(0, Math.min(promptTop + this.prompt.caret.row - dropped, height - 1));
      const col = Math.max(0, Math.min(this.prompt.caret.col, this.width - 1));
      caret = { row, col };
    }
    return { rows: rows.slice(0, height), caret };
  }

  render() {
    if (!this.active) return;
    const { rows, caret } = this.compose();
    const buffer = [SYNC_ON, CURSOR_HIDE, "\x1b[H"];
    for (let index = 0; index < rows.length; index++) {
      buffer.push("\x1b[2K", rows[index]);
      if (index < rows.length - 1) buffer.push("\r\n");
    }
    if (caret) {
      buffer.push(`\x1b[${caret.row + 1};${caret.col + 1}H`, CURSOR_SHOW);
      this._cursorVisible = true;
    } else {
      buffer.push(CURSOR_HIDE);
      this._cursorVisible = false;
    }
    buffer.push(SYNC_OFF);
    this._write(buffer.join(""));
  }

  /** Public API used by tests and by callers that need the plain text. */
  snapshot() {
    return {
      status: stripAnsi(this.status),
      rows: this.compose().rows.map((row) => stripAnsi(row)),
      caret: this.compose().caret,
      scroll: this.scroll,
    };
  }
}

export { isWheel };
