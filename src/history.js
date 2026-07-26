// src/history.js — sliding window + summarize-old scheme [heuristic: common
// pattern, not asserted as optimal for any specific workload].
const WINDOW_TURNS = 12;
const SUMMARIZE_THRESHOLD = 20;

// Improvement 3: bounded retry + explicit failure signaling on the
// summarization call. Previously, a transient provider failure inside
// compressIfNeeded threw uncaught out of handleChat, killing the whole
// session for what is a non-essential compaction step. Now: retry twice,
// and on exhausted failure, fall back to returning the original messages
// unchanged (degrade to "no compression this turn" rather than "session
// crashes"), while surfacing the failure to the caller via a return flag
// so callers can log/warn without the summarization error masquerading as
// a chat-turn error.
export async function compressIfNeeded(messages, routeChatFn, { retries = 2 } = {}) {
  if (messages.length <= SUMMARIZE_THRESHOLD) {
    return { messages, compressed: false, error: null };
  }

  const toSummarize = messages.slice(0, messages.length - WINDOW_TURNS);
  const keep = messages.slice(messages.length - WINDOW_TURNS);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { message } = await routeChatFn([
        { role: "system", content: "Summarize the following conversation history concisely, preserving facts, decisions, and unresolved threads. Output only the summary." },
        { role: "user", content: toSummarize.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n") },
      ], []);

      return {
        messages: [
          { role: "system", content: `[Earlier conversation summary]: ${message.content}` },
          ...keep,
        ],
        compressed: true,
        error: null,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  return { messages, compressed: false, error: lastErr };
}