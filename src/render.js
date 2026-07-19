// src/render.js
//
// Best-effort "make tool results legible" layer. Every heuristic here is
// a display convenience, not a correctness-critical parser -- on any
// ambiguity or parse failure this falls back to printing the raw text
// exactly as the pre-existing printResult always did, so this file can
// only improve legibility, never hide or corrupt output.
import { spawnSync } from "node:child_process";
import { colors, style } from "./colors.js";

const MAX_CELL_WIDTH = 40;
let warnedNoPager = false;

function colorizeJSON(value, indent = 0) {
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);

  if (value === null) return colors.magenta("null");
  if (typeof value === "boolean") return colors.magenta(String(value));
  if (typeof value === "number") return colors.yellow(String(value));
  if (typeof value === "string") return colors.green(JSON.stringify(value));

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => pad1 + colorizeJSON(v, indent + 1));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const items = keys.map((k) => `${pad1}${colors.cyan(JSON.stringify(k))}: ${colorizeJSON(value[k], indent + 1)}`);
    return `{\n${items.join(",\n")}\n${pad}}`;
  }

  return String(value);
}

// Table heuristic [heuristic, confidence: medium]: renders as a table only
// when every element is a non-null, non-array plain object. A genuinely
// mixed or nested array falls back to pretty-printed JSON instead of a
// malformed table -- deliberately conservative, since a wrong table is
// worse than no table.
function isFlatObjectArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  );
}

function cellStr(v) {
  if (v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > MAX_CELL_WIDTH ? s.slice(0, MAX_CELL_WIDTH - 1) + "…" : s;
}

function renderTable(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cellStr(r[c]).length)));

  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const out = [
    style.heading(line(cols)),
    colors.dim(widths.map((w) => "-".repeat(w)).join("  ")),
    ...rows.map((r) => line(cols.map((c) => cellStr(r[c])))),
  ];
  return out.join("\n");
}

// Pager fallback [heuristic]: `less -R` preserves the ANSI color codes
// this module emits (-R = raw control chars); `-F` exits immediately if
// content is shorter than one screen, so short results never hang
// waiting for a `q`. Non-TTY stdout (redirected/piped) always skips the
// pager -- piping colored, paginated output into another program would
// corrupt it, and `--json` (see renderResult) is the intended path for
// that case anyway.
// [unverified — check before relying on this]: `less` availability on a
// bare Windows cmd.exe/PowerShell host without Git-for-Windows or WSL is
// not confirmed here. ENOENT is caught and this falls back to a plain
// console.log with a one-time notice rather than throwing, so absence of
// `less` degrades gracefully rather than breaking the command.
function maybePage(text) {
  const rows = process.stdout.rows ?? 24;
  const tooLong = text.split("\n").length > rows - 2;
  if (!process.stdout.isTTY || !tooLong) {
    console.log(text);
    return;
  }
  const result = spawnSync("less", ["-R", "-F"], { input: text, stdio: ["pipe", "inherit", "inherit"] });
  if (result.error) {
    if (!warnedNoPager) {
      console.log(style.muted(`(no pager available: ${result.error.code ?? result.error.message} -- printing directly)`));
      warnedNoPager = true;
    }
    console.log(text);
  }
}

// Entry point. `mcpResult` is the raw object from client.callTool();
// opts.json bypasses all formatting and prints exactly
// JSON.stringify(mcpResult, null, 2) with no pager, for scripting
// (`--json` flag in index.js).
export function renderResult(mcpResult, opts = {}) {
  if (opts.json) {
    console.log(JSON.stringify(mcpResult, null, 2));
    return;
  }

  const text = (mcpResult.content ?? [])
    .map((b) => (b.type === "text" ? b.text : JSON.stringify(b, null, 2)))
    .join("\n");

  if (!text) {
    console.log(style.muted(JSON.stringify(mcpResult, null, 2)));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    maybePage(text);
    return;
  }

  const rendered = isFlatObjectArray(parsed) ? renderTable(parsed) : colorizeJSON(parsed);
  maybePage(rendered);
}

export { renderTable, colorizeJSON, isFlatObjectArray }; // exported for the unit-test script