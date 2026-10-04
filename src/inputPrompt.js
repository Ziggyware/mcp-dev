// src/inputPrompt.js
//
// The interactive input runtime behind every session prompt: the main palette,
// argument forms, path navigation, the JSON editor, and approvals. It owns
// raw-mode stdin, the key decoder, the inline renderer, and the editing model.
//
// Responsibilities are deliberately narrow: this module never knows what a
// command or a tool is — callers supply completions, previews, and key
// overrides, and receive the submitted text.

import { createKeyDecoder, TERMINAL_MODES } from "./keys.js";
import { InlineFrame } from "./frame.js";
import { visibleWidth, clipText } from "./terminal.js";
import { colors, marks, style } from "./colors.js";
import * as L from "./lineEditor.js";
import { rankByFuzzy } from "./fuzzy.js";

const ESCAPE_FLUSH_MS = 35;
const COMPLETION_DEBOUNCE_MS = 25;

export const KIND_COLORS = {
  cmd: style.toolName,
  server: style.serverName,
  tool: (s) => colors.cyan(s),
  chat: (s) => colors.green(s),
  cache: (s) => colors.yellow(s),
  path: (s) => colors.blue(s),
  hint: (s) => colors.faint(s),
  history: (s) => colors.gray(s),
};

/** Result of a finished prompt. */
export function ok(text, extra = {}) {
  return { ok: true, text, ...extra };
}

export const CANCELLED_RESULT = Object.freeze({ ok: false, reason: "cancel" });
export const EOF_RESULT = Object.freeze({ ok: false, reason: "eof" });

export function isCancelled(result) {
  return !result || result.ok === false;
}

function highlightLabel(label, indices) {
  if (!indices?.length) return label;
  const chars = Array.from(label);
  const set = new Set(indices);
  let out = "";
  let buffer = "";
  let bufferedMatch = null;
  for (let index = 0; index < chars.length; index++) {
    const matched = set.has(index);
    if (bufferedMatch === null || matched === bufferedMatch) {
      buffer += chars[index];
      bufferedMatch = matched;
      continue;
    }
    out += bufferedMatch ? style.match(buffer) : buffer;
    buffer = chars[index];
    bufferedMatch = matched;
  }
  if (buffer) out += bufferedMatch ? style.match(buffer) : buffer;
  return out;
}

export class KillRing {
  constructor() {
    this.items = [];
  }

  push(text) {
    if (text) this.items.unshift(text);
    if (this.items.length > 10) this.items.pop();
  }

  last() {
    return this.items[0] ?? "";
  }
}

export class InputHistory {
  constructor({ entries = [], limit = 500, file = null } = {}) {
    this.entries = [...entries];
    this.limit = limit;
    this.file = file;
    this.dirty = false;
  }

  add(text) {
    const value = String(text ?? "");
    if (!value.trim()) return;
    if (this.entries[this.entries.length - 1] === value) return;
    this.entries.push(value);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.dirty = true;
  }

  list() {
    return this.entries;
  }

  search(query) {
    const needle = String(query ?? "").toLowerCase();
    const matches = [];
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (!needle || entry.toLowerCase().includes(needle)) matches.push(entry);
      if (matches.length >= 60) break;
    }
    return matches;
  }
}

/**
 * Run one interactive prompt.
 *
 * @param {object} options
 * @param {string|string[]|Function} [options.title] lines rendered above the input
 * @param {string|Function} [options.message] prompt prefix (default "❯")
 * @param {string} [options.initialText]
 * @param {"enter"|"ctrl+enter"} [options.submitKey]
 * @param {Function} [options.completions] async (text, state) => { items, note }
 * @param {Function} [options.preview] async (state) => string[]
 * @param {Function} [options.hints] (state) => string[]
 * @param {Function} [options.footer] (state) => string[]
 * @param {Function} [options.onKey] (event, api) => boolean (true = handled)
 * @param {Function} [options.validate] (text) => true | string
 * @param {InputHistory} [options.history]
 * @param {number} [options.menuSize]
 * @param {boolean} [options.tabInserts] fall back to a literal tab
 * @param {boolean} [options.allowNewline]
 */
export function runPrompt(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    return Promise.resolve({ ok: false, reason: "not-a-tty" });
  }

  const frame = new InlineFrame(output);
  const decoder = createKeyDecoder();
  const history = options.history ?? null;
  const killRing = options.killRing ?? new KillRing();
  const menuSize = options.menuSize ?? 6;
  const submitOnCtrlEnter = options.submitKey === "ctrl+enter";
  const allowNewline = options.allowNewline !== false;
  const tabInserts = options.tabInserts !== false;

  const state = {
    line: L.createLine(options.initialText ?? "", options.initialCursor),
    entries: [],
    selected: 0,
    note: null,
    userMoved: false,
    lastAccepted: null,
    transient: options.status ? { text: options.status.text ?? String(options.status), tone: options.status.tone ?? "info" } : null,
    search: null,
    overlay: null,
    overlayOffset: 0,
    historyIndex: null,
    historyDraft: "",
    busy: false,
    ghost: "",
    requestId: 0,
    closed: false,
  };

  let resolveResult;
  let finished = false;
  const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
  let flushTimer = null;
  let completionTimer = null;
  let transientTimer = null;

  const promptPrefix = () => {
    const value = typeof options.message === "function" ? options.message(state) : options.message;
    return value ?? marks.prompt();
  };
  const titleLines = () => {
    const value = typeof options.title === "function" ? options.title(state) : options.title;
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  };

  // ---------------------------------------------------------------- rendering
  function buildInputLines(width, prompt) {
    const lines = [];
    let caret = null;
    const textLines = state.line.text.split("\n");
    const caretPos = L.caretRowCol(state.line.text, state.line.cursor);
    const indent = " ".repeat(visibleWidth(prompt) + 1);
    for (let index = 0; index < textLines.length; index++) {
      const isCaretLine = index === caretPos.row;
      const prefix = index === 0 ? `${prompt} ` : indent;
      const available = Math.max(8, width - visibleWidth(prefix));
      if (isCaretLine) {
        const window = L.horizontalWindow(textLines[index], caretPos.col, available);
        if (typeof options.decorateInput === "function") {
          const decorated = options.decorateInput(window.text, {
            index,
            lineCount: textLines.length,
            caretCol: window.caret,
            hiddenLeft: window.hiddenLeft,
            hiddenRight: window.hiddenRight,
            available,
            state,
          });
          if (decorated && typeof decorated === "object") {
            lines.push(`${prefix}${decorated.text}`);
            caret = { row: lines.length - 1, col: visibleWidth(prefix) + (decorated.caret ?? window.caret) };
            continue;
          }
          if (typeof decorated === "string") {
            lines.push(`${prefix}${decorated}`);
            caret = { row: lines.length - 1, col: visibleWidth(prefix) + window.caret };
            continue;
          }
        }
        const before = window.text.slice(0, window.caret);
        const after = window.text.slice(window.caret);
        const showGhost = index === textLines.length - 1 && caretPos.col === textLines[index].length && state.ghost;
        const suffix = showGhost ? colors.faint(state.ghost.slice(0, Math.max(0, available - window.text.length))) : "";
        const leftMark = window.hiddenLeft > 0 ? colors.faint("…") : "";
        const rightMark = window.hiddenRight > 0 ? colors.faint("…") : "";
        lines.push(`${leftMark}${prefix}${before}${after}${suffix}${rightMark}`);
        caret = { row: lines.length - 1, col: visibleWidth(leftMark) + visibleWidth(prefix) + window.caret };
      } else {
        lines.push(clipText(`${prefix}${textLines[index]}`, width));
      }
    }
    return { lines, caret };
  }

  function buildMenuLines(width) {
    if (!state.entries.length) return { lines: [], height: 0 };
    const lines = [];
    const start = Math.max(0, Math.min(state.selected - 1, state.entries.length - menuSize));
    const visible = state.entries.slice(start, start + menuSize);
    for (let index = 0; index < visible.length; index++) {
      const entry = visible[index];
      const absolute = start + index;
      const active = absolute === state.selected;
      const item = entry.item;
      const label = highlightLabel(String(item.label ?? ""), entry.indices);
      const color = KIND_COLORS[item.kind] ?? ((text) => text);
      const pointer = active ? marks.pointer() : " ";
      const rendered = active ? style.selected(color(label)) : color(label);
      const badge = item.badge ? ` ${item.badge}` : "";
      const description = item.description ? `  ${colors.faint(item.description)}` : "";
      lines.push(clipText(`  ${pointer} ${rendered}${badge}${description}`, width));
    }
    if (state.entries.length > menuSize) {
      const hidden = state.entries.length - visible.length;
      lines.push(colors.faint(`    … ${hidden} more — keep typing to narrow`));
    }
    return { lines, height: lines.length };
  }

  function build() {
    const width = frame.width;
    const lines = [];
    let caret = null;
    for (const line of titleLines()) lines.push(line);

    const prompt = promptPrefix();
    const input = buildInputLines(width, prompt);
    lines.push(...input.lines);
    caret = input.caret;

    for (const line of (typeof options.footer === "function" ? options.footer(state) ?? [] : options.footer ?? [])) {
      lines.push(line);
    }

    if (state.transient) {
      const tone = state.transient.tone === "error" ? colors.error
        : state.transient.tone === "warn" ? colors.warning
          : state.transient.tone === "success" ? colors.success
            : colors.muted;
      lines.push(clipText(`  ${tone(state.transient.text)}`, width));
    }

    if (state.overlay) {
      const window = state.overlay.slice(state.overlayOffset, state.overlayOffset + Math.max(4, (output.rows ?? 24) - lines.length - 3));
      for (const line of window) lines.push(line);
      lines.push(colors.faint("  ↑/↓ scroll · Esc close"));
      return { lines, caret };
    }

    if (state.search) {
      const matches = state.search.matches;
      lines.push(clipText(`  ${colors.yellow("reverse-i-search:")} ${state.search.query}`, width));
      const windowed = matches.slice(0, 5);
      for (let index = 0; index < windowed.length; index++) {
        const active = index === state.search.index;
        lines.push(clipText(`  ${active ? marks.pointer() : " "} ${active ? colors.bold(windowed[index]) : colors.muted(windowed[index])}`, width));
      }
      return { lines, caret };
    }

    const menu = buildMenuLines(width);
    if (menu.lines.length) lines.push(...menu.lines);
    if (state.note) lines.push(clipText(`  ${colors.warning(state.note)}`, width));

    const previewLines = typeof options.preview === "function" ? options.preview(state) ?? [] : [];
    if (previewLines.length) {
      for (const line of previewLines) lines.push(clipText(`  ${line}`, width));
    }

    const hintLines = typeof options.hints === "function" ? options.hints(state) ?? [] : options.hints ?? [];
    if (hintLines.length) {
      lines.push(colors.faint(clipText(hintLines.map((line) => line).join("  ·  "), width)));
    }

    return { lines, caret };
  }

  function render() {
    if (finished) return;
    const { lines, caret } = build();
    frame.render(lines, caret);
  }

  // ------------------------------------------------------------- completions
  function scheduleCompletions(delay = COMPLETION_DEBOUNCE_MS) {
    if (!options.completions) return;
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = setTimeout(() => { void refreshCompletions(); }, delay);
  }

  async function refreshCompletions() {
    if (!options.completions || finished) return;
    const requestId = ++state.requestId;
    const text = state.line.text;
    let result;
    try {
      result = await options.completions(text, { cursor: state.line.cursor, state });
    } catch {
      result = { items: [] };
    }
    if (requestId !== state.requestId || finished) return;
    if (state.line.text !== text) return;
    const items = Array.isArray(result) ? result : result?.items ?? [];
    state.note = result?.note ?? null;
    // Callers rank and limit their own completions (fuzzy ranking happens in
    // the caller so it can mix sources); the runtime only displays them.
    state.entries = items.slice(0, 200).map((item) => ({ item, indices: item.indices ?? [] }));
    if (state.selected >= state.entries.length) state.selected = Math.max(0, state.entries.length - 1);
    state.ghost = computeGhost(text);
    render();
  }

  function computeGhost(text) {
    if (!history || !text || state.line.cursor !== text.length) return "";
    const entries = history.list();
    for (let index = entries.length - 1; index >= 0; index--) {
      const candidate = entries[index];
      if (candidate.length > text.length && candidate.startsWith(text)) return candidate.slice(text.length);
    }
    return "";
  }

  // --------------------------------------------------------------- operations
  function setLine(next, { resetCompletion = true } = {}) {
    state.line = next;
    if (resetCompletion) {
      state.userMoved = false;
      state.selected = 0;
      state.lastAccepted = null;
      scheduleCompletions();
    }
    state.ghost = computeGhost(next.text);
  }

  function setTransient(text, tone = "info", { ttl = 4000 } = {}) {
    state.transient = text ? { text, tone } : null;
    if (transientTimer) clearTimeout(transientTimer);
    if (ttl > 0) {
      transientTimer = setTimeout(() => {
        state.transient = null;
        render();
      }, ttl);
    }
  }

  function replaceSelection(text) {
    setLine(L.replaceRange(state.line, state.lastAccepted?.regionStart ?? 0, state.line.cursor, text));
  }

  function acceptCompletion({ reverse = false, viaTab = true } = {}) {
    const entry = state.entries[state.selected];
    if (!entry) {
      if (viaTab && tabInserts) setLine(L.insertText(state.line, "\t"));
      else setTransient("No completion available.", "warn", { ttl: 1600 });
      return;
    }
    const item = entry.item;
    if (item.complete === false) {
      if (viaTab && tabInserts) setLine(L.insertText(state.line, "\t"));
      return;
    }
    const regionStart = item.regionStart ?? state.lastAccepted?.regionStart ?? 0;
    const current = state.line.text.slice(regionStart, state.line.cursor);
    if (current === item.insertText) {
      // Repeating Tab cycles through the remaining candidates, then falls back
      // to a literal tab instead of duplicating the accepted text.
      const nextIndex = state.selected + (reverse ? -1 : 1);
      const wrapped = (nextIndex + state.entries.length) % state.entries.length;
      const candidate = state.entries[wrapped]?.item;
      if (candidate && candidate.complete !== false && candidate.insertText !== item.insertText) {
        state.selected = wrapped;
        state.lastAccepted = { regionStart, text: candidate.insertText };
        setLine(L.replaceRange(state.line, regionStart, state.line.cursor, candidate.insertText), { resetCompletion: false });
        scheduleCompletions();
        return;
      }
      if (viaTab && tabInserts) setLine(L.insertText(state.line, "\t"));
      return;
    }
    state.lastAccepted = { regionStart, text: item.insertText };
    state.selected = Math.max(0, state.entries.findIndex((candidate) => candidate.item === item));
    const next = L.replaceRange(state.line, regionStart, state.line.cursor, item.insertText);
    // Add a trailing space when the completion is a whole token (commands,
    // servers, tools) so the caret lands at the end, ready for arguments.
    const withSpace = item.trailingSpace && !next.text.slice(next.cursor).startsWith(" ")
      ? L.insertText(next, " ")
      : next;
    setLine(withSpace, { resetCompletion: false });
    scheduleCompletions();
  }

  function navigateMenu(delta) {
    if (!state.entries.length) return false;
    state.userMoved = true;
    state.selected = (state.selected + delta + state.entries.length) % state.entries.length;
    return true;
  }

  function historyStep(delta) {
    if (!history) return false;
    const entries = history.list();
    if (!entries.length) return false;
    if (state.historyIndex === null) {
      if (delta > 0) return false;
      state.historyDraft = state.line.text;
      state.historyIndex = entries.length - 1;
    } else {
      const next = state.historyIndex + delta;
      if (next < 0) {
        state.historyIndex = null;
        setLine(L.createLine(state.historyDraft));
        return true;
      }
      if (next >= entries.length) return true;
      state.historyIndex = next;
    }
    setLine(L.createLine(entries[state.historyIndex]));
    return true;
  }

  function deleteWordBefore() {
    const killed = state.line.text.slice(
      L.deleteWordBefore(state.line).cursor,
      state.line.cursor
    );
    killRing.push(killed);
    setLine(L.deleteWordBefore(state.line));
  }

  function cancel() {
    finish({ ok: false, reason: "cancel" });
  }

  function closeOverlay() {
    state.overlay = null;
    state.overlayOffset = 0;
    render();
  }

  function openOverlay(lines, { offset = 0 } = {}) {
    state.overlay = lines;
    state.overlayOffset = offset;
    render();
  }

  function finish(result) {
    if (finished) return;
    finished = true;
    detach();
    frame.erase();
    if (result.ok && options.echo !== false && result.text) {
      const prompt = promptPrefix();
      const textLines = String(result.text).split("\n");
      const indent = " ".repeat(visibleWidth(prompt) + 1);
      output.write(textLines.map((line, index) => `${index === 0 ? `${prompt} ` : indent}${style.body(line)}`).join("\n") + "\n");
    }
    resolveResult(result);
  }

  async function submit(text = state.line.text, item = null) {
    if (state.busy) return;
    const value = String(text ?? "");
    if (options.validate) {
      state.busy = true;
      let verdict;
      try { verdict = await options.validate(value); } catch (error) { verdict = error.message; }
      state.busy = false;
      if (finished) return;
      if (verdict !== true) {
        setTransient(typeof verdict === "string" ? verdict : "Invalid input.", "error", { ttl: 5000 });
        render();
        return;
      }
    }
    if (history && value.trim()) history.add(value);
    finish({ ok: true, text: value, item });
  }

  const api = {
    get state() { return state; },
    get line() { return state.line; },
    get selectedItem() { return state.entries[state.selected]?.item ?? null; },
    hasCompletions: () => state.entries.length > 0,
    setLine,
    insertText: (text) => setLine(L.insertText(state.line, text)),
    replaceLine: (text) => setLine(L.createLine(text)),
    submit: (text) => { void submit(text ?? state.line.text); },
    setTransient,
    setNote: (note) => { state.note = note; render(); },
    setGhost: (ghost) => { state.ghost = ghost; render(); },
    openOverlay,
    closeOverlay,
    close: (reason = "cancel") => finish({ ok: false, reason }),
    render,
    clearMenu: () => { state.entries = []; state.selected = 0; render(); },
    acceptCompletion: (opts) => acceptCompletion(opts),
    killRing,
  };

  // -------------------------------------------------------------- key handling
  function insertPasted(text) {
    const sanitized = allowNewline
      ? String(text).replace(/\r\n?/g, "\n")
      : String(text).replace(/\r?\n/g, " ").replace(/\t/g, " ");
    setLine(L.insertText(state.line, sanitized));
  }

  function handleSearchKey(event) {
    const search = state.search;
    if (event.name === "escape" || (event.name === "char" && event.ctrl && event.text === "c")) {
      state.search = null;
      render();
      return;
    }
    if (event.name === "enter") {
      const match = search.matches[search.index] ?? search.query;
      state.search = null;
      setLine(L.createLine(match));
      render();
      return;
    }
    if (event.name === "char" && event.ctrl && event.text === "r") {
      search.index = (search.index + 1) % Math.max(1, search.matches.length);
      render();
      return;
    }
    if (event.name === "backspace") {
      search.query = search.query.slice(0, -1);
    } else if (event.name === "char" && event.text) {
      search.query += event.text;
    } else if (event.name === "space") {
      search.query += " ";
    } else {
      return;
    }
    search.matches = history ? history.search(search.query) : [];
    search.index = 0;
    render();
  }

  function handleOverlayKey(event) {
    if (event.name === "escape" || event.name === "enter" || (event.name === "char" && event.text === "q")) {
      closeOverlay();
      return;
    }
    if (event.name === "down") { state.overlayOffset += 1; render(); return; }
    if (event.name === "up") { state.overlayOffset = Math.max(0, state.overlayOffset - 1); render(); return; }
    if (event.name === "pageup") { state.overlayOffset = Math.max(0, state.overlayOffset - 10); render(); return; }
    if (event.name === "pagedown") { state.overlayOffset += 10; render(); }
  }

  function handleKey(event) {
    if (state.overlay) return handleOverlayKey(event);
    if (state.search) return handleSearchKey(event);

    if (options.onKey && options.onKey(event, api) === true) {
      render();
      return;
    }

    const { line } = state;

    if (event.name === "newline") {
      setLine(L.insertText(line, "\n"), { resetCompletion: false });
      scheduleCompletions(0);
      return;
    }

    if (event.name === "escape") {
      if (line.text) {
        killRing.push(line.text);
        setLine(L.createLine(""));
        setTransient("Input cleared — Ctrl+Y restores it.", "info", { ttl: 2500 });
      } else if (state.entries.length) {
        state.entries = [];
        render();
      } else {
        setTransient("Nothing to cancel. Press ? for help, Ctrl+D to exit.", "info", { ttl: 2500 });
        render();
      }
      return;
    }

    if (event.name === "enter") {
      const wantsNewline = !submitOnCtrlEnter
        ? (event.ctrl || event.meta || event.shift || event.burst) && allowNewline
        : !(event.ctrl || event.meta) && !event.shift;
      if (wantsNewline) {
        setLine(L.insertText(line, "\n"), { resetCompletion: false });
        scheduleCompletions(0);
        return;
      }
      if (state.entries.length && state.userMoved) {
        const item = state.entries[state.selected]?.item;
        if (item?.complete === false) {
          void submit(item.submitText ?? line.text, item);
          return;
        }
        acceptCompletion({ viaTab: false });
        return;
      }
      void submit();
      return;
    }

    if (event.name === "tab" || event.name === "backtab") {
      if (state.entries.length && state.entries[state.selected]?.item.complete !== false) {
        acceptCompletion({ reverse: event.name === "backtab" });
      } else if (event.name === "tab" && event.shift && options.onShiftTab) {
        options.onShiftTab(api);
      } else if (event.name === "backtab" && options.onShiftTab) {
        options.onShiftTab(api);
      } else if (event.name === "tab" && tabInserts) {
        setLine(L.insertText(line, "\t"), { resetCompletion: false });
      }
      return;
    }

    if (event.name === "up" || event.name === "down") {
      const delta = event.name === "up" ? -1 : 1;
      if (navigateMenu(delta)) { render(); return; }
      if (historyStep(delta)) { render(); return; }
      return;
    }

    if (event.ctrl && event.name === "char" && event.text === "p") { if (historyStep(-1)) render(); return; }
    if (event.ctrl && event.name === "char" && event.text === "n") { if (historyStep(1)) render(); return; }
    if (event.ctrl && event.name === "char" && event.text === "r") {
      state.search = { query: "", matches: history ? history.search("") : [], index: 0 };
      render();
      return;
    }
    if (event.ctrl && event.name === "char" && event.text === "l") {
      output.write("\x1b[2J\x1b[H");
      frame.height = 0;
      render();
      return;
    }
    if (event.ctrl && event.name === "char" && event.text === "c") { cancel(); return; }
    if (event.ctrl && event.name === "char" && event.text === "d") {
      if (line.text) setLine(L.deleteForward(line), { resetCompletion: false });
      else finish({ ok: false, reason: "eof" });
      return;
    }
    if (event.ctrl && event.name === "char" && event.text === "a") { setLine(L.moveLineStart(line), { resetCompletion: false }); return; }
    if (event.ctrl && event.name === "char" && event.text === "e") { setLine(L.moveLineEnd(line), { resetCompletion: false }); return; }
    if (event.ctrl && event.name === "char" && event.text === "b") { setLine(L.moveLeft(line), { resetCompletion: false }); return; }
    if (event.ctrl && event.name === "char" && event.text === "f") { setLine(L.moveRight(line), { resetCompletion: false }); return; }
    if (event.ctrl && event.name === "char" && event.text === "w") { deleteWordBefore(); return; }
    if (event.ctrl && event.name === "char" && event.text === "u") {
      const killed = line.text.slice(0, line.cursor);
      killRing.push(killed);
      setLine(L.deleteToLineStart(line));
      return;
    }
    if (event.ctrl && event.name === "char" && event.text === "k") {
      const killed = line.text.slice(line.cursor);
      killRing.push(killed);
      setLine(L.deleteToLineEnd(line));
      return;
    }
    if (event.ctrl && event.name === "char" && event.text === "y") {
      if (killRing.last()) setLine(L.insertText(line, killRing.last()));
      return;
    }
    if (event.meta && event.name === "char" && event.text === "b") { setLine(L.moveWordLeft(line), { resetCompletion: false }); return; }
    if (event.meta && event.name === "char" && event.text === "f") { setLine(L.moveWordRight(line), { resetCompletion: false }); return; }
    if (event.meta && event.name === "char" && event.text === "d") { setLine(L.deleteWordAfter(line)); return; }

    if (event.name === "left") {
      setLine(event.ctrl || event.meta ? L.moveWordLeft(line) : L.moveLeft(line), { resetCompletion: false });
      return;
    }
    if (event.name === "right") {
      if (line.cursor === line.text.length && state.ghost) {
        setLine(L.createLine(line.text + state.ghost));
        return;
      }
      setLine(event.ctrl || event.meta ? L.moveWordRight(line) : L.moveRight(line), { resetCompletion: false });
      return;
    }
    if (event.name === "home") { setLine(L.moveLineStart(line), { resetCompletion: false }); return; }
    if (event.name === "end") { setLine(L.moveLineEnd(line), { resetCompletion: false }); return; }
    if (event.name === "backspace") {
      setLine(event.ctrl || event.meta ? L.deleteWordBefore(line) : L.backspace(line));
      return;
    }
    if (event.name === "delete") { setLine(L.deleteWordAfter(line), { resetCompletion: false }); return; }
    if (event.name === "space") { setLine(L.insertText(line, " ")); return; }
    if (event.name === "char" && event.text) { setLine(L.insertText(line, event.text)); return; }
  }

  // --------------------------------------------------------------- lifecycle
  function onData(chunk) {
    if (finished) return;
    let events = decoder.push(chunk);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (decoder.pending()) {
      flushTimer = setTimeout(() => {
        const flushed = decoder.forceFlush();
        for (const event of flushed) handleKey(event);
        render();
      }, ESCAPE_FLUSH_MS);
    }
    for (const event of events) {
      if (event.type === "paste") insertPasted(event.text);
      else handleKey(event);
    }
    if (events.length) render();
  }

  function onSigint() { cancel(); }
  // The tty can report EOF instead of delivering Ctrl+D as a byte when the
  // press lands while the prompt is not attached (between commands). Treat
  // stdin ending like Ctrl+D so the session still leaves cleanly.
  function onEnd() { finish({ ok: false, reason: "eof" }); }
  function onResize() { render(); }

  function attach() {
    input.setRawMode?.(true);
    input.resume?.();
    input.on("data", onData);
    input.on("end", onEnd);
    output.on?.("resize", onResize);
    process.on("SIGINT", onSigint);
    output.write(TERMINAL_MODES.enter);
    // Ctrl+D pressed between commands can end the stream before this prompt
    // attaches; without this check the prompt would wait forever on a stdin
    // that can never produce another byte.
    if (input.readableEnded || input.destroyed) {
      finish({ ok: false, reason: "eof" });
      return;
    }
  }

  function detach() {
    if (flushTimer) clearTimeout(flushTimer);
    if (completionTimer) clearTimeout(completionTimer);
    if (transientTimer) clearTimeout(transientTimer);
    input.off?.("data", onData);
    input.off?.("end", onEnd);
    output.off?.("resize", onResize);
    process.off("SIGINT", onSigint);
    input.setRawMode?.(false);
    input.pause?.();
    output.write(TERMINAL_MODES.leave);
  }

  attach();
  render();
  scheduleCompletions(0);
  return resultPromise;
}

/** Convenience: run a prompt and return the text, or null when cancelled. */
export async function promptText(options = {}) {
  const result = await runPrompt(options);
  return result.ok ? result.text : null;
}
