import { spawnSync } from "node:child_process";
import { colors, style } from "./colors.js";
import { renderMarkdown } from "./markdown.js";
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
  if (process.env.PAGER) candidates.push(process.env.PAGER);
  candidates.push("less", "more");
  return [...new Set(candidates)];
}

function maybePage(text) {
  const rows = process.stdout.rows ?? 24;
  const tooLong = text.split("\n").length > rows - 2;
  if (!process.stdout.isTTY || !tooLong) {
    console.log(text);
    return;
  }

  for (const pager of resolvePagerCandidates()) {
    const args = pager === "less" ? ["-R", "-F"] : [];
    const result = spawnSync(pager, args, { input: text, stdio: ["pipe", "inherit", "inherit"] });
    if (!result.error) return;
  }

  if (!warnedNoPager) {
    console.log(style.muted("(no pager available on PATH -- printing directly)"));
    warnedNoPager = true;
  }
  console.log(text);
}

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

  const directRender = !Array.isArray(parsed) ? renderItem(parsed) : null;
  if (directRender) {
    maybePage(directRender);
    return;
  }

  const items = unwrapItems(parsed);
  if (items && items.length > 0) {
    const rendered = items.map(renderItem);
    if (rendered.every((r) => r !== null)) {
      maybePage(rendered.join(`\n${colors.dim("─".repeat(40))}\n`));
      return;
    }
  }

  const fallback = isFlatObjectArray(parsed) ? renderTable(parsed) : colorizeJSON(parsed);
  maybePage(fallback);
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