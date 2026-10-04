// src/typeahead.js
//
// Type-ahead buffer. Long-running work (connecting, calling a tool) owns stdin
// while it runs so it can offer cancellation. Bytes the user types during that
// window must not be swallowed: they are queued here and replayed into the next
// prompt, exactly like a shell's type-ahead.

const queue = [];

export function pushBytes(chunk) {
  if (!chunk) return;
  queue.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  if (queue.length > 200) queue.splice(0, queue.length - 200);
}

export function drainBytes() {
  return queue.splice(0);
}

export function hasPending() {
  return queue.length > 0;
}

export function clearBytes() {
  queue.length = 0;
}

/**
 * Split a raw chunk into the parts that mean "cancel" and the parts that are
 * ordinary typing. Ctrl+C always cancels; Escape only when it arrives alone
 * (an arrow key also starts with Escape and must be replayed instead).
 */
export function splitCancelChunk(text) {
  const value = String(text ?? "");
  if (!value) return { cancel: false, rest: "" };
  if (value === "\u001b") return { cancel: true, rest: "" };

  let rest = "";
  let cancel = false;
  for (const char of value) {
    if (char === "\u0003") {
      cancel = true;
      continue;
    }
    rest += char;
  }
  return { cancel, rest };
}
