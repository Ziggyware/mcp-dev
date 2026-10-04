// src/pathPrompt.js
//
// Filesystem-aware text prompt. Shows the working directory, lists the entries
// of the directory being typed, completes paths with Tab, and lets ↑/↓ walk the
// listing, so choosing a path never means memorising a full absolute path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPrompt } from "./inputPrompt.js";
import { colors, marks, style } from "./colors.js";
import { terminalColumns } from "./terminal.js";

const MAX_ENTRIES = 80;

export function expandHome(value, home = os.homedir()) {
  const text = String(value ?? "");
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(home, text.slice(2));
  return text;
}

export function resolveInputPath(value, baseDir) {
  const expanded = expandHome(String(value ?? ""));
  if (!expanded) return baseDir;
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

/** Shorten an absolute path for display; keeps the tail readable. */
export function displayPath(target, { baseDir = process.cwd(), home = os.homedir(), width = 60 } = {}) {
  const value = String(target ?? "");
  let shown = value;
  if (value.startsWith(home)) shown = `~${value.slice(home.length)}`;
  const relative = path.relative(baseDir, value);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const candidate = relative.startsWith(".") ? relative : `./${relative}`;
    if (candidate.length < shown.length) shown = candidate;
  }
  return shown.length > width ? `…${shown.slice(-(width - 1))}` : shown;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function readDirectory(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name !== "." && entry.name !== "..")
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try { isDirectory = fs.statSync(fullPath).isDirectory(); } catch { /* broken link */ }
        }
        return { name: entry.name, directory: isDirectory, path: fullPath };
      })
      .sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1))
      .slice(0, MAX_ENTRIES);
  } catch {
    return null;
  }
}

function statOf(entry) {
  if (!entry || entry.directory) return null;
  try {
    return fs.statSync(entry.path);
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} [options.baseDir] directory relative paths resolve against
 * @param {"file"|"dir"|"any"} [options.mode]
 * @param {string} [options.initialText]
 * @returns {Promise<{ok:true,text:string}|{ok:false,reason:string}>}
 */
export async function promptPathValue({
  label,
  baseDir = process.cwd(),
  mode = "any",
  initialText = "",
  schema = {},
  history = null,
  message = "❯",
} = {}) {
  const suffix = mode === "dir" ? "directory" : mode === "file" ? "file" : "path";

  return runPrompt({
    title: [
      `${style.heading(label)} ${colors.faint(`— ${suffix}`)}`,
      colors.faint(`  base ${marks.bullet()} ${colors.path(displayPath(baseDir, { baseDir }))} ${colors.faint("· Tab completes and opens directories · ↑/↓ browse")}`),
    ],
    message,
    initialText,
    history,
    menuSize: 8,
    status: { text: `Enter accepts · Tab completes · ~ and relative paths resolve against ${displayPath(baseDir, { baseDir })}`, tone: "info" },
    completions: (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        const entries = readDirectory(baseDir) ?? [];
        return {
          items: entries.map((entry) => ({
            label: entry.directory ? `${entry.name}/` : entry.name,
            insertText: entry.name,
            regionStart: 0,
            description: entry.directory ? "directory" : "file",
            kind: "path",
            complete: true,
          })),
        };
      }
      const absolute = resolveInputPath(trimmed, baseDir);
      const endsWithSeparator = /[\\/]$/.test(trimmed);
      const dir = endsWithSeparator ? absolute : path.dirname(absolute);
      const base = endsWithSeparator ? "" : path.basename(absolute);
      const directory = readDirectory(dir);
      if (!directory) return { items: [], note: `Cannot read directory ${displayPath(dir, { baseDir })}` };
      const needle = base.toLowerCase();
      const items = [];
      if (!endsWithSeparator) {
        for (const entry of directory) {
          if (!entry.name.toLowerCase().startsWith(needle)) continue;
          items.push({
            label: entry.directory ? `${entry.name}/` : entry.name,
            insertText: entry.name,
            regionStart: Math.max(0, text.length - base.length),
            description: entry.directory ? "directory" : "file",
            kind: "path",
            complete: true,
          });
        }
      } else {
        for (const entry of directory) {
          items.push({
            label: entry.directory ? `${entry.name}/` : entry.name,
            // Append after the separator the user already typed instead of
            // replacing the whole line.
            insertText: `${text.slice(0, text.length - text.trimStart().length)}${entry.name}${entry.directory ? "/" : ""}`,
            regionStart: 0,
            description: entry.directory ? "directory" : "file",
            kind: "path",
            complete: true,
          });
        }
      }
      if (base === "") {
        items.unshift({
          label: "../",
          insertText: "../",
          regionStart: 0,
          description: "parent directory",
          kind: "path",
          complete: true,
        });
      }
      return { items, note: items.length ? null : `No matches in ${displayPath(dir, { baseDir })}` };
    },
    footer: (state) => {
      const text = state.line.text.trim();
      const resolved = text ? resolveInputPath(text, baseDir) : baseDir;
      const lines = [`  ${colors.faint("resolves to")} ${colors.path(displayPath(resolved, { baseDir }))}`];
      try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) lines.push(`  ${marks.ok()} ${colors.success("directory")} ${colors.faint("press Tab to browse it")}`);
        else lines.push(`  ${marks.ok()} ${colors.success("file")} ${colors.faint(`${formatBytes(stat.size)} · modified ${stat.mtime.toISOString().slice(0, 16).replace("T", " ")}`)}`);
      } catch {
        if (text) lines.push(`  ${marks.warn()} ${colors.warning("path does not exist yet")}`);
      }
      return lines;
    },
    preview: (state) => {
      const selected = state.entries[state.selected]?.item;
      if (!selected) return [];
      const text = state.line.text.trim();
      const resolvedText = resolveInputPath(text || ".", baseDir);
      const dir = text ? (/[\\/]$/.test(text) ? resolvedText : path.dirname(resolvedText)) : baseDir;
      const target = path.join(dir, String(selected.insertText ?? "").trim().replace(/\/$/, ""));
      const isDir = /\/$/.test(selected.label ?? "");
      const stat = statOf({ path: target, directory: isDir });
      const parts = [isDir ? colors.blue("directory") : colors.body("file")];
      if (stat && !isDir) parts.push(colors.faint(formatBytes(stat.size)));
      parts.push(colors.path(displayPath(target, { baseDir, width: Math.max(24, terminalColumns() - 24) })));
      return [parts.join("  ")];
    },
    escapeCancels: true,
    hints: () => ["Tab complete/open", "↑/↓ browse", "Enter accept", "Esc cancel"],
    validate: (text) => {
      if (!String(text).trim()) return "A path is required.";
      return true;
    },
  });
}
