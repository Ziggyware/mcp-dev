// src/keys.js
//
// Raw terminal key decoding.
//
// Node's readline keypress parser is lossy for modern key encodings: it
// reports `\x1b[13;5u` (Ctrl+Enter, kitty protocol) and `\x1b[27;5;13~`
// (Ctrl+Enter, xterm modifyOtherKeys) as `name: undefined` and then leaks the
// remaining bytes (`13~`) into the input line as literal text. It also cannot
// distinguish Shift+Enter from Enter. The session UI therefore decodes stdin
// itself, and this module is the single place that knows the escape sequences.
//
// The decoder is a pure buffering state machine: push raw bytes in, get
// normalized key events out. It handles split reads (a sequence may arrive in
// several chunks) and bracketed pastes.

import { StringDecoder } from "node:string_decoder";

const ESC = "\x1b";

export const TERMINAL_MODES = {
  enter: [
    "\x1b[?2004h", // bracketed paste: paste arrives as one marked block
    "\x1b[>4;2m",  // xterm/VTE modifyOtherKeys=2: Ctrl+Enter, Ctrl+arrows, ...
    "\x1b[>1u",    // kitty keyboard protocol: disambiguate escape codes
  ].join(""),
  leave: [
    "\x1b[<u",     // pop kitty keyboard flags
    "\x1b[>4;0m",  // restore modifyOtherKeys
    "\x1b[?2004l", // bracketed paste off
    "\x1b[?25h",   // cursor visible again
  ].join(""),
};

const CSI_U_NAMES = new Map([
  [9, "tab"],
  [10, "enter"],
  [13, "enter"],
  [27, "escape"],
  [32, "space"],
  [127, "backspace"],
]);

const TILDE_KEYS = new Map([
  [1, "home"], [2, "insert"], [3, "delete"], [4, "end"],
  [5, "pageup"], [6, "pagedown"], [7, "home"], [8, "end"],
  [11, "f1"], [12, "f2"], [13, "f3"], [14, "f4"], [15, "f5"],
  [17, "f6"], [18, "f7"], [19, "f8"], [20, "f9"], [21, "f10"],
  [23, "f11"], [24, "f12"],
  [29, "menu"],
]);

const FINAL_KEYS = new Map([
  ["A", "up"], ["B", "down"], ["C", "right"], ["D", "left"],
  ["H", "home"], ["F", "end"], ["Z", "backtab"],
  ["P", "f1"], ["Q", "f2"], ["R", "f3"], ["S", "f4"],
]);

function event(name, { ctrl = false, meta = false, shift = false, text, sequence, chunkSize = 1, burst = false } = {}) {
  return { type: "key", name, ctrl, meta, shift, text, sequence, chunkSize, burst };
}

/** Decode the `mods` parameter of CSI/CSI-u sequences (1 means "no mods"). */
export function decodeModifiers(parameter) {
  const value = Number(parameter) || 1;
  const bits = Math.max(0, value - 1);
  return {
    shift: Boolean(bits & 1),
    meta: Boolean(bits & 2),
    ctrl: Boolean(bits & 4),
    super: Boolean(bits & 8),
  };
}

function keyFromCode(code, mods, sequence, chunk) {
  const ctrl = mods.ctrl;
  if (code === 13 || code === 10) return event("enter", { ...mods, sequence, ...chunk });
  if (code === 9) return code === 9 && mods.shift ? event("backtab", { ...mods, sequence, ...chunk }) : event("tab", { ...mods, sequence, ...chunk });
  if (code === 27) return event("escape", { ...mods, sequence, ...chunk });
  if (code === 32) return event("space", { ...mods, sequence, ...chunk, text: " " });
  if (code === 127 || code === 8) {
    // Plain ^H is ambiguous across terminals; treat it as the Ctrl+Backspace
    // form so word deletion works in Windows Terminal and xterm.
    return event("backspace", { ...mods, ctrl: ctrl || code === 8, sequence, ...chunk });
  }
  if (code >= 32) {
    return event("char", { ...mods, text: String.fromCodePoint(code), sequence, ...chunk });
  }
  return event("unknown", { ...mods, sequence, ...chunk });
}

function applyTildeKey(params, sequence, chunk) {
  const [first, second, third] = params;
  if (first === 27 && params.length >= 3) {
    // xterm modifyOtherKeys: CSI 27 ; mods ; code ~
    return keyFromCode(third, decodeModifiers(second), sequence, chunk);
  }
  if (first === 27 && params.length === 2) {
    return event("escape", { sequence, ...chunk });
  }
  const name = TILDE_KEYS.get(first);
  if (!name) return event("unknown", { sequence, ...chunk });
  const mods = decodeModifiers(second);
  return event(name, { ...mods, sequence, ...chunk });
}

function applyCsi(final, params, sequence, chunk) {
  const mods = params.length > 1 ? decodeModifiers(params[1]) : { shift: false, meta: false, ctrl: false };
  if (final === "~") return applyTildeKey(params, sequence, chunk);
  if (final === "u") {
    // kitty: CSI unicode-key-code ; modifiers u
    if (!params.length) return event("unknown", { sequence, ...chunk });
    const [code, modsParam] = params;
    return keyFromCode(code, decodeModifiers(modsParam), sequence, chunk);
  }
  const name = FINAL_KEYS.get(final);
  if (!name) return event("unknown", { sequence, ...chunk });
  return event(name, { ...mods, sequence, ...chunk });
}

function isIncomplete(str) {
  if (str === ESC) return true;
  if (str.startsWith(`${ESC}[`)) return !/[\x40-\x7e]$/.test(str.slice(2));
  if (str === `${ESC}O`) return true;
  return false;
}

/**
 * SGR mouse report: `CSI < button ; column ; row M|m`. Only decoded when the
 * terminal was asked for mouse tracking (the session's screen asks for wheel
 * events); elsewhere the report is swallowed like any other private CSI so it
 * can never leak into the input line.
 */
function decodeMouse(str) {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(str);
  if (!match) return null;
  return {
    length: match[0].length,
    event: {
      type: "mouse",
      button: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      release: match[4] === "m",
      sequence: match[0],
    },
  };
}

/**
 * Decode one event from the front of `str`.
 * @returns {{length:number, event:object}|{incomplete:true}|{length:number}}
 */
function decodeOne(str, { mouse = false } = {}) {
  const first = str[0];

  if (first !== ESC) {
    const code = str.codePointAt(0);
    const width = code > 0xffff ? 2 : 1;
    if (code === 0x0d) return { length: 1, event: event("enter", { sequence: "\r" }) };
    if (code === 0x0a) return { length: 1, event: event("newline", { sequence: "\n" }) };
    if (code === 0x09) return { length: 1, event: event("tab", { sequence: "\t" }) };
    if (code === 0x7f) return { length: 1, event: event("backspace", { sequence: "\x7f" }) };
    if (code === 0x08) return { length: 1, event: event("backspace", { ctrl: true, sequence: "\b" }) };
    if (code === 0x00) return { length: 1, event: event("space", { ctrl: true, sequence: "\x00" }) };
    if (code < 0x20) {
      const letter = String.fromCharCode(code + 96);
      if (letter >= "a" && letter <= "z") return { length: 1, event: event("char", { ctrl: true, text: letter, sequence: first }) };
      return { length: 1, event: event("unknown", { sequence: first }) };
    }
    // Consume a run of printable characters so pastes and fast typing arrive
    // as a single insert rather than one keystroke per character.
    let end = 0;
    let text = "";
    while (end < str.length) {
      const ch = str.codePointAt(end);
      if (ch === 0x1b || ch < 0x20 || ch === 0x7f) break;
      text += String.fromCodePoint(ch);
      end += ch > 0xffff ? 2 : 1;
    }
    return { length: end, event: event("char", { text, sequence: text }) };
  }

  // Escape sequences.
  if (str.length === 1) return { incomplete: true };

  const second = str[1];
  if (second === "[") {
    const match = /^\x1b\[([0-9;:]*)([A-Za-z~@^])/.exec(str);
    if (match) {
      const params = match[1].split(/[;:]/).filter((part) => part !== "").map(Number);
      return { length: match[0].length, event: applyCsi(match[2], params, match[0]) };
    }
    if (!/[\x40-\x7e]/.test(str.slice(2))) return { incomplete: true };
    if (mouse) {
      const report = decodeMouse(str);
      if (report) return report;
    }
    // Private CSI (mouse reports, mode replies, terminal queries) carries no
    // input intent — swallow it entirely so it can never leak as text.
    const finalIndex = str.slice(2).search(/[\x40-\x7e]/);
    return { length: 2 + finalIndex + 1 };
  }

  if (second === "O") {
    if (str.length === 2) return { incomplete: true };
    const final = str[2];
    if (FINAL_KEYS.has(final)) return { length: 3, event: event(FINAL_KEYS.get(final), { sequence: str.slice(0, 3) }) };
    return { length: 3, event: event("unknown", { sequence: str.slice(0, 3) }) };
  }

  if (second === ESC) return { length: 1, event: event("escape", { sequence: ESC }) };

  // Alt/Meta + single character.
  const code = str.codePointAt(1);
  const width = code > 0xffff ? 2 : 1;
  const rest = str.slice(1, 1 + width);
  if (code === 0x0d) return { length: 2, event: event("enter", { meta: true, sequence: `${ESC}\r` }) };
  if (code === 0x7f || code === 0x08) return { length: 2, event: event("backspace", { meta: true, ctrl: true, sequence: `${ESC}${rest}` }) };
  if (code >= 0x20) {
    if (code === 0x20) return { length: 2, event: event("space", { meta: true, sequence: `${ESC}${rest}`, text: " " }) };
    return { length: 2, event: event("char", { meta: true, text: rest, sequence: `${ESC}${rest}` }) };
  }
  // ESC followed by an unrelated control character (Esc then Ctrl+D, say).
  // Emit the Escape and let the control byte decode on its own: swallowing the
  // pair would lose a real keypress.
  return { length: 1, event: event("escape", { sequence: ESC }) };
}

export function createKeyDecoder({ mouse = false } = {}) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let pasting = false;
  let pasteText = "";
  let lastChunk = 1;
  let lastChunkBlock = false;

  /**
   * `burst` marks keys that arrived inside a *block* of lines rather than from
   * one keystroke: a multi-line paste (bracketed paste off) or a terminal that
   * coalesced several keystrokes into one read. It must stay false for ordinary
   * fast typing — "abc" and Enter arriving in the same read is still an Enter,
   * and treating it as a newline was what made the prompt look like it needed
   * two presses. Only a line break with more text behind it means "block".
   */
  function annotate(ev) {
    if (!ev) return ev;
    if (ev.chunkSize === undefined) ev.chunkSize = lastChunk;
    ev.burst = lastChunk > 4 && lastChunkBlock;
    return ev;
  }

  function consume() {
    const events = [];
    while (buffer.length > 0) {
      if (pasting) {
        const end = buffer.indexOf("\x1b[201~");
        if (end === -1) {
          // Keep collecting; cap runaway data so a lost end marker cannot
          // exhaust memory.
          if (buffer.length + pasteText.length > 1_000_000) {
            pasting = false;
            events.push({ type: "paste", text: pasteText + buffer.slice(0, 1_000_000) });
            pasteText = "";
            buffer = "";
          }
          break;
        }
        pasteText += buffer.slice(0, end);
        buffer = buffer.slice(end + 6);
        pasting = false;
        events.push({ type: "paste", text: pasteText });
        pasteText = "";
        continue;
      }

      if (buffer.startsWith("\x1b[200~")) {
        // Do not treat a lone "\x1b[1" as a paste start: require the full marker.
        buffer = buffer.slice(6);
        pasting = true;
        continue;
      }

      const result = decodeOne(buffer, { mouse });
      if (result.incomplete) break;
      if (!result.event) {
        // Defensive: never loop forever on an undecodable prefix.
        buffer = buffer.slice(Math.max(1, result.length ?? 1));
        continue;
      }
      events.push(annotate(result.event));
      buffer = buffer.slice(result.length);
    }
    return events;
  }

  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      buffer += text;
      lastChunk = chunk.length;
      // A break with more bytes behind it is a block of lines, not one Enter.
      lastChunkBlock = /[\r\n][\s\S]/.test(text);
      return consume();
    },
    /** True when the buffer holds a possibly-incomplete sequence. */
    pending() {
      return pasting || buffer.length > 0;
    },
    /**
     * Called after a short idle delay. A lone ESC keypress never produces more
     * bytes, so flush it as Escape instead of waiting forever.
     */
    forceFlush() {
      if (pasting) return [];
      if (!buffer) return [];
      const events = [];
      if (buffer.startsWith(ESC)) {
        // Drop the incomplete escape prefix, then decode the remainder.
        buffer = buffer.slice(1);
        while (buffer.length && /^[\[\];0-9:O]/.test(buffer)) buffer = buffer.slice(1);
        events.push({ type: "key", name: "escape", ctrl: false, meta: false, shift: false, sequence: ESC, chunkSize: lastChunk, burst: false });
      }
      return [...events, ...consume()];
    },
    reset() {
      buffer = "";
      pasting = false;
      pasteText = "";
    },
  };
}

/** Compact description used by tests and the debug overlay. */
export function describeEvent(ev) {
  if (!ev) return "none";
  if (ev.type === "paste") return `paste(${ev.text.length})`;
  if (ev.type === "mouse") {
    const wheel = (ev.button & 64) === 64 ? (ev.button & 1 ? "down" : "up") : null;
    return `mouse:${wheel ? `wheel-${wheel}` : `button-${ev.button}`}`;
  }
  const mods = [ev.ctrl && "ctrl", ev.meta && "alt", ev.shift && "shift"].filter(Boolean).join("+");
  const label = ev.name === "char" && ev.text ? `char:${JSON.stringify(ev.text)}` : ev.name;
  return mods ? `${mods}+${label}` : label;
}
