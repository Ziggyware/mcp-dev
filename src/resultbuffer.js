// src/resultBuffer.js
//
// Session-scoped ring buffer of tool-call results, plus a minimal
// back-reference resolver ("!!" / "!<n>" / "!<n>.<path>") so a value
// returned by one tool call can be reused as an argument to the next
// without re-typing or copy-pasting it.
//
// Scope note [derived]: this is NOT a general JSONPath/JMESPath engine.
// Path syntax supports only dot-separated object keys and bracket
// numeric array indices, e.g. "!3.items[0].id". Wildcards, filters, and
// slices are unsupported -- unsupported syntax throws a descriptive
// error rather than silently returning undefined.
//
// Persistence [heuristic]: the buffer is in-memory only and cleared on
// process exit or `clear`. No disk persistence, by design -- a tool
// result may contain data the user did not ask to have written to disk.
// `save` in session.js is the explicit, one-entry-at-a-time opt-in for
// that.
//
// Failure mode (disclosed, not fixed): any literal argument value that
// itself starts with "!" followed by "!" or digits (e.g. a shell command
// string, a factorial notation, an actual "!123" ticket ID) will be
// misread as a back-reference instead of taken literally. There is no
// escape syntax for this in v1 -- if this collides with real argument
// values in a given server's tool schema, use the array/object JSON
// editor path instead (see suggest.js), which does not apply backref
// resolution to nested field values, only to the initial single-line
// prompt.

const DEFAULT_CAPACITY = 20;

export class ResultBuffer {
  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.entries = []; // { index, server, tool, args, text, mcpResult }
    this.nextIndex = 1;
  }

  // `mcpResult` is the raw object returned by client.callTool(). `text` is
  // derived once here (the same join-logic every other result printer in
  // this codebase used ad hoc) so the renderer, the backref resolver, and
  // `save` all read one canonical string instead of re-deriving it three
  // different ways with three chances to drift apart.
  push({ server, tool, args, mcpResult }) {
    const text = (mcpResult.content ?? [])
      .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
      .join("\n");
    const entry = { index: this.nextIndex++, server, tool, args, text, mcpResult };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    return entry.index;
  }

  get(index) {
    return this.entries.find((e) => e.index === index);
  }

  last() {
    return this.entries[this.entries.length - 1];
  }

  list() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }
}

const BACKREF_RE = /^!(?:(!)|(\d+))(?:\.(.+))?$/;

// "items[0].id" -> ["items", "0", "id"]. Brackets are normalized to dots
// first, then every segment is validated against a plain identifier/digit
// pattern -- this is what turns genuinely unsupported syntax (wildcards,
// spaces, filter expressions) into an explicit error instead of a wrong
// silent result.
function tokenizePath(path) {
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  const tokens = normalized.split(".").filter((t) => t.length > 0);
  for (const t of tokens) {
    if (!/^[A-Za-z0-9_$]+$/.test(t)) {
      throw new Error(`Unsupported path segment "${t}" in "${path}" (only dotted keys and [n] indices are supported)`);
    }
  }
  return tokens;
}

function walkPath(value, tokens) {
  let cur = value;
  for (const t of tokens) {
    if (cur === null || cur === undefined) {
      throw new Error(`Path stopped at "${t}" -- value was ${JSON.stringify(cur)}`);
    }
    if (Array.isArray(cur) && /^\d+$/.test(t)) {
      cur = cur[Number(t)];
    } else if (typeof cur === "object") {
      cur = cur[t];
    } else {
      throw new Error(`Cannot index into ${typeof cur} at "${t}"`);
    }
  }
  return cur;
}

// Returns { matched: false } if `raw` is not backref syntax at all (the
// common case -- most typed args are literal values, not "!something"),
// so callers can cheaply fall through to normal handling.
// Returns { matched: true, value, isString, sourceIndex } on success, or
// { matched: true, error } if it looks like a backref but resolution
// failed (unknown index, non-JSON text with a path requested, bad path).
export function resolveBackref(raw, buffer) {
  const m = BACKREF_RE.exec(String(raw).trim());
  if (!m) return { matched: false };

  const [, bang, idxStr, path] = m;
  const entry = bang ? buffer.last() : buffer.get(Number(idxStr));
  if (!entry) {
    return { matched: true, error: `No cached result for "${raw}". Run \`results\` to see what's available.` };
  }

  if (!path) {
    return { matched: true, value: entry.text, isString: true, sourceIndex: entry.index };
  }

  let parsed;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    return { matched: true, error: `Result #${entry.index} is not JSON -- cannot apply path ".${path}".` };
  }

  try {
    const tokens = tokenizePath(path);
    const value = walkPath(parsed, tokens);
    if (value === undefined) {
      return { matched: true, error: `Path ".${path}" not found in result #${entry.index}.` };
    }
    return { matched: true, value, isString: typeof value === "string", sourceIndex: entry.index };
  } catch (err) {
    return { matched: true, error: `${err.message} (result #${entry.index})` };
  }
}