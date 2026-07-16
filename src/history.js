// src/history.js — one reasonable scheme, NOT asserted as "the modern
// standard." Sliding window of the last N raw turns kept verbatim, older
// turns periodically collapsed into a running summary via one extra LLM
// call. This is a standard-shaped pattern (recency window + summarize-old),
// not a claim about what's current best practice as of any specific date.
const WINDOW_TURNS = 12; // raw turns kept verbatim before summarization
const SUMMARIZE_THRESHOLD = 20; // trigger a compression pass past this count

export async function compressIfNeeded(messages, routeChatFn) {
  if (messages.length <= SUMMARIZE_THRESHOLD) return messages;

  const toSummarize = messages.slice(0, messages.length - WINDOW_TURNS);
  const keep = messages.slice(messages.length - WINDOW_TURNS);

  const { message } = await routeChatFn([
    { role: "system", content: "Summarize the following conversation history concisely, preserving facts, decisions, and unresolved threads. Output only the summary." },
    { role: "user", content: toSummarize.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n") },
  ], []);

  return [
    { role: "system", content: `[Earlier conversation summary]: ${message.content}` },
    ...keep,
  ];
}