// src/wire.js
//
// Message-format conversion between the Anthropic shape (what the session
// stores and what the existing agent loop speaks) and the OpenAI shape (what
// the nokey-router and every other OpenAI-compatible endpoint speak).
//
// Anthropic user message:  { role: "user", content: string | [ {type:"text"|…},
//                            {type:"tool_result", tool_use_id, content} ] }
// Anthropic assistant:     { role: "assistant", content: [ {type:"text", text},
//                            {type:"tool_use", id, name, input} ] }
// OpenAI assistant:        { role: "assistant", content: string|null,
//                            tool_calls?: [{ id, type:"function",
//                                            function: { name, arguments } }] }
// OpenAI tool result:      { role: "tool", tool_call_id, content: string }

/** Flatten any Anthropic content into plain text (for digests and logging). */
export function anthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? flattenToolResult(block.content) : JSON.stringify(block)))
    .join("\n")
    .trim();
}

function flattenToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n");
  return String(content ?? "");
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n");
  }
  return JSON.stringify(content ?? "");
}

/**
 * Convert stored Anthropic-format messages to the OpenAI chat array.
 * `system` becomes the leading system message. Tool results ride in the next
 * Anthropic user message; on the wire they must follow the assistant message
 * as role:"tool" entries, in tool_call order, before any user text.
 */
export function anthropicToOpenAi(messages, { system = null } = []) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const toolCalls = blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: safeJsonStringify(block.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user (or anything else): split tool_result blocks from text blocks.
    const content = message.content;
    if (typeof content === "string") {
      if (content.length) out.push({ role: "user", content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const toolMessages = [];
    const textParts = [];
    for (const block of content) {
      if (block?.type === "tool_result") {
        toolMessages.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block.content) });
      } else if (block?.type === "text") {
        textParts.push(block.text);
      } else if (block != null) {
        textParts.push(JSON.stringify(block));
      }
    }
    out.push(...toolMessages);
    if (textParts.length) out.push({ role: "user", content: textParts.join("\n") });
  }
  return out;
}

/** Convert one OpenAI assistant message into stored Anthropic blocks. */
export function openAiAssistantToAnthropic(message) {
  const blocks = [];
  const text = typeof message.content === "string" ? message.content : "";
  if (text) blocks.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name ?? "unknown",
      input: safeJsonParse(call.function?.arguments ?? "{}"),
    });
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function safeJsonParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: String(text) };
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
