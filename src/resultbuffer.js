// src/resultBuffer.js
//
// Session-scoped ring buffer of tool-call results, plus a back-reference
// resolver ("!!" / "!<n>" / "!<n>.<path>") so a value returned by one tool
// call can be reused as an argument to the next.

const DEFAULT_CAPACITY = 20;

export class ResultBuffer {
  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.entries = [];
    this.nextIndex = 1;
  }

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

class PathParseError extends Error {
  constructor(message, path, position) {
    super(`${message} at position ${position} in "${path}"`);
    this.name = "PathParseError";
  }
}

class PathParser {
  constructor(path) {
    this.path = path;
    this.pos = 0;
  }

  peek() {
    return this.path[this.pos];
  }

  error(message) {
    throw new PathParseError(message, this.path, this.pos);
  }

  atEnd() {
    return this.pos >= this.path.length;
  }

  parse() {
    const segments = [{ type: "key", name: this.parseKey() }];
    while (!this.atEnd()) {
      segments.push(this.parseSegment());
    }
    return segments;
  }

  parseSegment() {
    const c = this.peek();
    if (c === ".") {
      this.pos++;
      return { type: "key", name: this.parseKey() };
    }
    if (c === "[") {
      this.pos++;
      const seg = this.parseBracketBody();
      if (this.peek() !== "]") this.error(`expected "]"`);
      this.pos++;
      return seg;
    }
    this.error(`expected "." or "[", found "${c}"`);
  }

  parseBracketBody() {
    if (this.peek() === "*") {
      this.pos++;
      return { type: "wildcard" };
    }
    const start = this.pos;
    if (this.peek() === "-") this.pos++;
    const digitsStart = this.pos;
    while (!this.atEnd() && /[0-9]/.test(this.peek())) this.pos++;
    if (this.pos === digitsStart) {
      this.error("expected a numeric index or \"*\" inside [...]");
    }
    return { type: "index", value: Number(this.path.slice(start, this.pos)) };
  }

  parseKey() {
    const start = this.pos;
    while (!this.atEnd() && /[A-Za-z0-9_$]/.test(this.peek())) this.pos++;
    if (this.pos === start) {
      this.error("expected an identifier");
    }
    return this.path.slice(start, this.pos);
  }
}

export function parsePath(path) {
  const parser = new PathParser(path);
  const segments = parser.parse();
  if (!parser.atEnd()) {
    parser.error("unexpected trailing input");
  }
  return segments;
}

function resolveIndex(arr, i) {
  return i < 0 ? arr.length + i : i;
}

function walkSegments(value, segments, segIndex, pathStr) {
  if (segIndex === segments.length) return value;
  const seg = segments[segIndex];

  if (value === null || value === undefined) {
    throw new Error(`Path stopped -- value was ${JSON.stringify(value)} before segment ${segIndex + 1}`);
  }

  if (seg.type === "wildcard") {
    if (!Array.isArray(value)) {
      throw new Error(`"[*]" requires an array, got ${typeof value}`);
    }
    return value.map((el) => walkSegments(el, segments, segIndex + 1, pathStr));
  }

  if (seg.type === "index") {
    if (!Array.isArray(value)) {
      throw new Error(`"[${seg.value}]" requires an array, got ${typeof value}`);
    }
    const idx = resolveIndex(value, seg.value);
    if (idx < 0 || idx >= value.length) {
      throw new Error(`Index ${seg.value} out of range (array length ${value.length})`);
    }
    return walkSegments(value[idx], segments, segIndex + 1, pathStr);
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`".${seg.name}" requires an object, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
  if (!(seg.name in value)) {
    throw new Error(`Key "${seg.name}" not found`);
  }
  return walkSegments(value[seg.name], segments, segIndex + 1, pathStr);
}

export function walkPath(value, path) {
  const segments = parsePath(path);
  return walkSegments(value, segments, 0, path);
}

const BACKREF_RE = /^!(?:(!)|(\d+))(?:\.(.+))?$/;

export function resolveBackref(raw, buffer) {
  const str = String(raw).trim();
  if (str.startsWith("\\!")) {
    return { matched: false, literal: str.slice(1) };
  }
  const m = BACKREF_RE.exec(str);
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
    const value = walkPath(parsed, path);
    if (value === undefined) {
      return { matched: true, error: `Path ".${path}" not found in result #${entry.index}.` };
    }
    return { matched: true, value, isString: typeof value === "string", sourceIndex: entry.index };
  } catch (err) {
    return { matched: true, error: `${err.message} (result #${entry.index})` };
  }
}