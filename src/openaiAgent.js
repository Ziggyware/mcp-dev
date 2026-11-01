// src/openaiAgent.js
//
// The agent loop for OpenAI-compatible brains — the wire protocol the
// nokey-router (nokey-router.ziggyware.deno.net/v1) and every other
// OpenAI-compatible endpoint speaks. Mirrors runAgentTurn's contract:
// streaming text to stdout, approval-gated dispatch, bounded steps, and the
// same { text, steps } return value. Messages are stored in Anthropic shape
// and converted at the boundary, so the session transcript stays uniform.

import { anthropicToOpenAi, openAiAssistantToAnthropic } from "./wire.js";

export const OPENAI_AGENT_STEPS = 12;

const REQUEST_TIMEOUT_MS = 120_000;

function toOpenAiToolDefs(defs) {
  return (defs ?? []).map((def) => ({
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

async function streamChatCompletion({ base, apiKey, model, messages, tools, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`brain request timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(new Error("Cancelled by user (SIGINT)"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`brain HTTP ${response.status}${body ? `: ${body.slice(0, 400)}` : ""}`);
    }
    if (!response.body) throw new Error("brain returned an empty response body");

    // Some OpenAI-compatible endpoints ignore stream:true and answer with one
    // JSON document; handle that gracefully instead of parsing it as SSE.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("event-stream")) {
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`brain returned non-SSE, non-JSON content (${contentType || "unknown type"})`);
      }
      const choice = parsed.choices?.[0];
      if (!choice?.message) throw new Error("brain JSON response is missing choices[0].message");
      const message = choice.message;
      if (typeof message.content === "string" && message.content) process.stdout.write(message.content);
      return { message, finishReason: choice.finish_reason ?? null };
    }

    const contentParts = [];
    const toolCalls = new Map(); // index -> { id, name, arguments }
    let finishReason = null;

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // tolerate keep-alives and partial frames
        }
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length) {
          contentParts.push(delta.content);
          process.stdout.write(delta.content);
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          // Keep the full OpenAI shape: { id, type:"function", function:{ name, arguments } }
          const slot = toolCalls.get(index) ?? { id: `call_${index}`, type: "function", function: { name: "", arguments: "" } };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.function.name += call.function.name;
          if (typeof call.function?.arguments === "string") slot.function.arguments += call.function.arguments;
          toolCalls.set(index, slot);
        }
      }
    }

    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    return {
      message: {
        role: "assistant",
        content: contentParts.join(""),
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finishReason,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Run one agent turn against an OpenAI-compatible endpoint.
 * @param {object} options
 * @param {Array} options.messages  stored Anthropic-format transcript (mutated)
 * @param {Array} options.toolDefs  tool definitions: { name, description, input_schema }
 * @param {object} options.brain    { kind:"openai", base, apiKey, model, provider }
 * @param {string|null} options.userQuery
 * @param {string|null} options.system
 * @param {(name: string, input: object) => Promise<{content: string, is_error?: boolean}>} options.dispatch
 */
export async function runAgentTurnOpenAI({
  messages,
  toolDefs,
  brain,
  userQuery = null,
  system = null,
  dispatch,
  maxSteps = OPENAI_AGENT_STEPS,
}) {
  const openAiTools = toOpenAiToolDefs(toolDefs);
  if (userQuery !== null && userQuery !== undefined) messages.push({ role: "user", content: userQuery });

  let steps = 0;
  while (steps < maxSteps) {
    steps += 1;
    const wireMessages = anthropicToOpenAi(messages, { system });
    const { message } = await streamChatCompletion({
      base: brain.base,
      apiKey: brain.apiKey,
      model: brain.model,
      messages: wireMessages,
      tools: openAiTools,
    });

    const blocks = openAiAssistantToAnthropic(message);
    messages.push({ role: "assistant", content: blocks });
    const hasText = blocks.some((block) => block.type === "text" && block.text);
    if (hasText && !(message.tool_calls?.length)) {
      if (hasText) process.stdout.write("\n");
      return {
        text: blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
        steps,
      };
    }
    if (hasText) process.stdout.write("\n");
    if (!message.tool_calls?.length) {
      // The model stopped without answering (e.g. length cap). Say so.
      return { text: "[the model returned no answer and no tool calls]", steps };
    }

    const results = [];
    for (const call of message.tool_calls) {
      let input = {};
      const rawArguments = call.function?.arguments;
      if (typeof rawArguments === "string" && rawArguments.trim()) {
        try {
          input = JSON.parse(rawArguments);
        } catch {
          results.push({ tool_use_id: call.id, content: `Error: tool arguments were not valid JSON: ${rawArguments.slice(0, 200)}`, is_error: true });
          continue;
        }
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) input = { value: input };
      let outcome;
      try {
        outcome = await dispatch(call.function?.name ?? "unknown", input);
      } catch (error) {
        outcome = { content: `Error: ${error.message}`, is_error: true };
      }
      results.push({ tool_use_id: call.id, content: outcome.content, is_error: Boolean(outcome.is_error) });
    }
    messages.push({ role: "user", content: results.map((result) => ({ type: "tool_result", tool_use_id: result.tool_use_id, content: result.content })) });
  }

  return { text: `[stopped after ${maxSteps} tool-call steps without a final answer]`, steps: maxSteps };
}
