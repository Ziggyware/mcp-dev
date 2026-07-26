// src/markdown.js
//
// High-end markdown → ANSI renderer using the desaturated xterm-256 palette.
// No CommonMark completeness — only the subset needed for MCP doc-search.

import { colors, style } from "./colors.js";

const HEADER_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(\w*)\s*$/;
const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const INLINE_CODE_RE = /`([^`]+)`/g;

const HEADER_COLORS = [
  colors.accent,
  colors.secondary,
  colors.emphasis,
  colors.identifier,
  colors.warning,
  colors.success
];

const KEYWORDS = {
  javascript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "new", "try", "catch", "throw"],
  js: null,
  typescript: null,
  ts: null,
  csharp: ["using", "namespace", "class", "public", "private", "static", "void", "new", "return", "if", "else", "var", "string", "int", "bool", "async", "await", "try", "catch"],
  python: ["def", "class", "import", "from", "return", "if", "elif", "else", "for", "while", "try", "except", "with", "as", "None", "True", "False", "async", "await"],
  bash: ["if", "then", "else", "fi", "for", "do", "done", "echo", "export", "function"],
  shell: null,
  json: null
};
KEYWORDS.js = KEYWORDS.typescript = KEYWORDS.ts = KEYWORDS.javascript;
KEYWORDS.shell = KEYWORDS.bash;

function highlightCodeLine(line, lang) {
  const keywords = KEYWORDS[(lang || "").toLowerCase()];
  if (!keywords) return colors.secondary(line);

  const commentMatch = line.match(/^(\s*)(\/\/.*|#.*)$/);
  if (commentMatch) return colors.dim(line);

  const parts = line.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return colors.success(part);
    return part.replace(
      new RegExp(`\\b(${keywords.join("|")})\\b`, "g"),
      (m) => colors.emphasis(m)
    );
  }).join("");
}

function renderInline(text) {
  let out = text;

  out = out.replace(INLINE_CODE_RE, (_, code) =>
    colors.secondary(`\`${code}\``)
  );

  out = out.replace(BOLD_RE, (_, inner) =>
    colors.bold(colors.body(inner))
  );

  out = out.replace(LINK_RE, (_, label, url) =>
    `${colors.accent(label)} ${colors.dim(`(${url})`)}`
  );

  return out;
}

export function renderMarkdown(md) {
  const lines = String(md).split("\n");
  const out = [];
  let inFence = false;
  let fenceLang = "";

  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1] || "";
        out.push(
          colors.dim(
            `┌─ ${fenceLang || "code"} ${"─".repeat(Math.max(0, 30 - fenceLang.length))}`
          )
        );
      } else {
        inFence = false;
        out.push(colors.dim("└" + "─".repeat(34)));
      }
      continue;
    }

    if (inFence) {
      out.push("  " + highlightCodeLine(line, fenceLang));
      continue;
    }

    const headerMatch = line.match(HEADER_RE);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const colorFn = HEADER_COLORS[Math.min(level - 1, HEADER_COLORS.length - 1)];
      const prefix = "  ".repeat(level - 1);

      out.push("");
      out.push(prefix + colorFn(headerMatch[2].trim()));

      if (level === 1) {
        out.push(colors.dim("─".repeat(Math.min(60, headerMatch[2].trim().length + 2))));
      }
      continue;
    }

    const listMatch = line.match(LIST_RE);
    if (listMatch) {
      const [, indent, marker, rest] = listMatch;
      const bullet = /\d+\./.test(marker)
        ? colors.dim(marker)
        : colors.identifier("•");
      out.push(`${indent}${bullet} ${renderInline(rest)}`);
      continue;
    }

    out.push(renderInline(line));
  }

  return out.join("\n");
}