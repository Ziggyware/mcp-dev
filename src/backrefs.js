// src/backrefs.js
//
// Makes cached tool results discoverable. Cached values are one of the most
// useful parts of the session (`!3`, `!3.rows[0].id`, `!!`) and also one of the
// least obvious, so every text prompt can offer them as completions with a
// preview of the value each path resolves to.

import { colors, style } from "./colors.js";
import { summarizeJson } from "./schema.js";

const SAFE_PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function formatPathSegment(segment) {
  if (typeof segment === "number") return `[${segment}]`;
  return SAFE_PATH_SEGMENT.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
}

/**
 * Enumerate the referenceable paths inside one cached result, shallowest
 * first. Depth and count are bounded so a huge result cannot flood the menu.
 */
export function cacheEntryPaths(entry, { maxDepth = 3, limit = 40 } = {}) {
  const paths = [""];
  if (!entry) return paths;
  let parsed;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    return paths;
  }

  const walk = (value, prefix, depth) => {
    if (paths.length >= limit || depth > maxDepth || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const max = Math.min(value.length, 8);
      for (let index = 0; index < max && paths.length < limit; index++) {
        const next = `${prefix}${formatPathSegment(index)}`;
        paths.push(next);
        walk(value[index], next, depth + 1);
      }
      return;
    }
    const keys = Object.keys(value).slice(0, 10);
    for (const key of keys) {
      if (paths.length >= limit) return;
      const next = `${prefix}${formatPathSegment(key)}`;
      paths.push(next);
      walk(value[key], next, depth + 1);
    }
  };

  walk(parsed, "", 1);
  return paths;
}

/** Preview text for one path inside a cached entry. */
export function describeCachedPath(entry, path) {
  if (!entry) return "";
  if (!path) return `${entry.text.length} chars`;
  try {
    const parsed = JSON.parse(entry.text);
    let value = parsed;
    for (const match of path.matchAll(/\.([A-Za-z0-9_$]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g)) {
      const key = match[1] ?? (match[2] !== undefined ? Number(match[2]) : JSON.parse(`"${match[3]}"`));
      value = value?.[key];
    }
    if (value === undefined) return "path not found";
    if (Array.isArray(value)) return `array(${value.length}) ${summarizeJson(value, { maxLength: 32 })}`;
    if (value !== null && typeof value === "object") return `object(${Object.keys(value).length}) ${summarizeJson(value, { maxLength: 32 })}`;
    return `${typeof value} ${summarizeJson(value, { maxLength: 36 })}`;
  } catch {
    return "";
  }
}

/**
 * Completion items for cached results. `prefix` is what the user has typed so
 * far (for example `!`, `!3`, or `!3.rows`).
 */
export function cachedRefItems(resultBuffer, prefix = "!", { limit = 24 } = {}) {
  if (!resultBuffer) return [];
  const typed = String(prefix);
  const items = [];

  const last = resultBuffer.last();
  if (last && "!!".startsWith(typed)) {
    items.push({
      label: "!!",
      insertText: "!!",
      regionStart: 0,
      description: `last result — #${last.index} ${last.server}/${last.tool} ${describeCachedPath(last, "")}`,
      kind: "cache",
      complete: true,
    });
  }

  for (const entry of [...resultBuffer.list()].reverse()) {
    const base = `!${entry.index}`;
    if (!base.startsWith(typed.split(/[.[]/)[0])) continue;
    const paths = cacheEntryPaths(entry);
    for (const path of paths) {
      const ref = base + path;
      if (!ref.startsWith(typed)) continue;
      items.push({
        label: ref,
        insertText: ref,
        regionStart: 0,
        description: `${entry.server}/${entry.tool} ${colors.faint(describeCachedPath(entry, path))}`,
        kind: "cache",
        complete: true,
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

/** The reference chain implied by a partially typed backref. */
export function backrefRoot(value) {
  const match = /^(!(?:!|\d+))(?:\.[A-Za-z0-9_$]*|\[[^\]]*\])*$/.exec(String(value));
  if (!match) return null;
  const suffix = String(value).slice(match[1].length);
  const open = suffix.lastIndexOf(".");
  return { base: match[1], token: open === -1 ? "" : suffix.slice(open + 1), hasDot: open !== -1 };
}

export function describeBufferEntry(entry) {
  const preview = String(entry.text ?? "").replace(/\s+/g, " ").trim();
  return `${style.serverName(entry.server)}/${style.toolName(entry.tool)}  ${colors.faint(preview.length > 70 ? `${preview.slice(0, 69)}…` : preview)}`;
}
