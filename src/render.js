import { spawnSync } from "node:child_process";
import { colors, style } from "./colors.js";
import { renderMarkdown } from "./markdown.js";
import { parseCommandArguments } from "./args.js";
import { clipText, terminalColumns, visibleWidth } from "./terminal.js";
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

function isFlatObjectArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  );
}

function cellStr(value) {
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function padVisible(value, width) {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function fitTableWidths(columns, rows, terminalWidth = terminalColumns()) {
  const widths = columns.map((column) => Math.min(
    MAX_CELL_WIDTH,
    Math.max(6, visibleWidth(column), ...rows.map((row) => visibleWidth(cellStr(row[column]))))
  ));
  const available = Math.max(columns.length * 6, terminalWidth - Math.max(0, columns.length - 1) * 2);
  while (widths.reduce((total, width) => total + width, 0) > available) {
    const widest = widths.reduce((best, width, index) => width > widths[best] ? index : best, 0);
    if (widths[widest] <= 6) break;
    widths[widest]--;
  }
  return widths;
}

function renderTable(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!columns.length) return "{}";
  const widths = fitTableWidths(columns, rows);
  const line = (cells) => cells.map((cell, index) => padVisible(clipText(cell, widths[index]), widths[index])).join("  ");
  return [
    style.heading(line(columns)),
    colors.dim(widths.map((width) => "-".repeat(width)).join("  ")),
    ...rows.map((row) => line(columns.map((column) => cellStr(row[column])))),
  ].join("\n");
}

function collectUrl(value) {
  return value.url ?? value.link ?? value.contentUrl ?? value.href ?? null;
}

function looksLikeDocResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const hasTitle = typeof value.title === "string" || typeof value.name === "string";
  const hasBody = typeof value.content === "string" || typeof value.description === "string" || typeof value.summary === "string";
  return hasTitle && hasBody;
}

function extractParams(value) {
  const raw = value.parameters ?? value.params ?? value.properties ?? null;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((p) => ({
      name: p.name ?? p.key ?? "?",
      type: p.type ?? p.dataType ?? "",
      required: Boolean(p.required),
      description: p.description ?? p.summary ?? "",
    }));
  }
  if (typeof raw === "object") {
    const requiredSet = new Set(value.required ?? []);
    return Object.entries(raw).map(([name, p]) => ({
      name,
      type: (p && p.type) ?? "",
      required: requiredSet.has(name),
      description: (p && (p.description ?? p.summary)) ?? "",
    }));
  }
  return [];
}

function renderDocResult(value) {
  const title = value.title ?? value.name;
  const body = value.content ?? value.description ?? value.summary;
  if (!title || !body) return null;

  const lines = [];
  lines.push(style.heading(title));
  const url = collectUrl(value);
  if (url) lines.push(colors.dim(url));
  lines.push("");
  lines.push(renderMarkdown(String(body).trim()));

  const params = extractParams(value);
  if (params.length > 0) {
    lines.push("");
    lines.push(style.heading("Parameters"));
    const nameWidth = Math.max(...params.map((p) => p.name.length));
    for (const p of params) {
      const marker = p.required ? style.required("*") : " ";
      const namePart = `  ${marker}${colors.cyan(p.name.padEnd(nameWidth))}`;
      const typePart = p.type ? style.muted(` (${p.type})`) : "";
      lines.push(`${namePart}${typePart}`);
      if (p.description) lines.push(`      ${style.muted(p.description)}`);
    }
  }

  if (Array.isArray(value.examples) && value.examples.length > 0) {
    lines.push("");
    lines.push(style.heading("Examples"));
    for (const ex of value.examples) {
      lines.push(colors.dim(typeof ex === "string" ? ex : JSON.stringify(ex)));
    }
  }

  return lines.join("\n");
}

function looksLikeSnippetResult(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.codeSnippet === "string";
}

function renderSnippetResult(value) {
  if (typeof value.codeSnippet !== "string") return null;

  const lines = [];
  const heading = value.language ? `Code snippet (${value.language})` : "Code snippet";
  lines.push(style.heading(heading));
  const url = collectUrl(value);
  if (url) lines.push(colors.dim(url));
  if (value.description) {
    lines.push("");
    lines.push(String(value.description).trim());
  }
  lines.push("");
  lines.push(colors.cyan(value.codeSnippet));

  return lines.join("\n");
}

function looksLikeSingleFsEntry(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const hasPath = typeof value.path === "string" || typeof value.name === "string";
  const hasFsField = "size" in value || "type" in value || "isDirectory" in value
    || "isDir" in value || Array.isArray(value.entries);
  return hasPath && hasFsField;
}

function fsEntryLine(entry) {
  const name = entry.path ?? entry.name ?? "?";
  const isDir = entry.isDirectory ?? entry.isDir ?? entry.type === "directory";
  const marker = isDir ? colors.blue("d") : colors.dim("-");
  const sizePart = typeof entry.size === "number" ? style.muted(String(entry.size).padStart(10)) : " ".repeat(10);
  return `${marker} ${sizePart}  ${isDir ? colors.blue(name) : name}`;
}

function renderFsEntryResult(value) {
  if (!Array.isArray(value.entries)) return fsEntryLine(value);
  const lines = [];
  if (value.path ?? value.name) lines.push(style.heading(value.path ?? value.name));
  for (const e of value.entries) {
    if (!looksLikeSingleFsEntry(e)) return null;
    lines.push(fsEntryLine(e));
  }
  return lines.join("\n");
}

const ITEM_SHAPES = [
  { test: looksLikeDocResult, render: renderDocResult },
  { test: looksLikeSnippetResult, render: renderSnippetResult },
  { test: looksLikeSingleFsEntry, render: renderFsEntryResult },
];

function renderItem(item) {
  for (const shape of ITEM_SHAPES) {
    if (shape.test(item)) {
      const out = shape.render(item);
      if (out) return out;
    }
  }
  return null;
}

const LIST_WRAPPER_KEYS = ["results", "items", "data", "entries", "matches"];

function unwrapItems(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    for (const key of LIST_WRAPPER_KEYS) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return null;
}

// Improvement 8: pager fallback chain instead of a single hardcoded `less`.
// A prior environment without `less` on PATH (minimal containers, some
// Windows shells) always fell through to the "no pager available" warning
// even when `more` or `$PAGER` was usable. Now tries $PAGER first (user's
// explicit choice), then less, then more, before giving up.
function resolvePagerCandidates() {
  const candidates = [];
  if (process.env.PAGER) {
    try {
      const [command, ...args] = parseCommandArguments(process.env.PAGER);
      if (command) candidates.push({ command, args });
    } catch {
      // An invalid PAGER must not make a tool result undisplayable.
    }
  }
  candidates.push({ command: "less", args: ["-R", "-F"] }, { command: "more", args: [] });
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\u0000${candidate.args.join("\u0000")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function maybePage(text, { page = true } = {}) {
  const rows = process.stdout.rows ?? 24;
  const tooLong = text.split("\n").length > rows - 2;
  if (!page || !process.stdout.isTTY || !tooLong) {
    console.log(text);
    return;
  }

  for (const pager of resolvePagerCandidates()) {
    const result = spawnSync(pager.command, pager.args, { input: text, stdio: ["pipe", "inherit", "inherit"] });
    if (!result.error) return;
  }

  if (!warnedNoPager) {
    console.log(style.muted("(no pager available on PATH — printing directly)"));
    warnedNoPager = true;
  }
  console.log(text);
}

export function renderResult(mcpResult, opts = {}) {
  if (opts.json) {
    console.log(JSON.stringify(mcpResult, null, 2));
    return;
  }

  const blocks = mcpResult.content ?? [];
  const text = blocks
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block, null, 2)))
    .join("\n");
  const errorPrefix = mcpResult.isError ? `${style.error("Tool reported an error")}\n` : "";
  const pageOptions = { page: opts.pager !== false };

  if (!text) {
    maybePage(`${errorPrefix}${style.muted(JSON.stringify(mcpResult, null, 2))}`, pageOptions);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    maybePage(errorPrefix + text, pageOptions);
    return;
  }

  const directRender = !Array.isArray(parsed) ? renderItem(parsed) : null;
  if (directRender) {
    maybePage(errorPrefix + directRender, pageOptions);
    return;
  }

  const items = unwrapItems(parsed);
  if (items && items.length > 0) {
    const rendered = items.map(renderItem);
    if (rendered.every((item) => item !== null)) {
      maybePage(errorPrefix + rendered.join(`\n${colors.dim("─".repeat(40))}\n`), pageOptions);
      return;
    }
  }

  const fallback = isFlatObjectArray(parsed) ? renderTable(parsed) : colorizeJSON(parsed);
  maybePage(errorPrefix + fallback, pageOptions);
}

export {
  renderTable,
  colorizeJSON,
  isFlatObjectArray,
  looksLikeDocResult,
  renderDocResult,
  looksLikeSnippetResult,
  renderSnippetResult,
  looksLikeSingleFsEntry,
  renderFsEntryResult,
  unwrapItems,
};