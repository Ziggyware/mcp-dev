// src/suggest.js
//
// Agent execution (planning + tool dispatch) plus the argument-form entry
// points. Prompting lives in argForm.js / jsonPrompt.js / pathPrompt.js; the
// functions here are re-exported so existing callers keep working.

import { promptForArgs as runArgForm, CANCELLED as FORM_CANCELLED } from "./argForm.js";
import { validateArguments } from "./schema.js";

export const CANCELLED = FORM_CANCELLED;
export const MAX_AGENT_STEPS = 8;

export { validateArguments };

/**
 * Collect arguments for a tool call.
 * @param {object} inputSchema
 * @param {import("./resultBuffer.js").ResultBuffer} resultBuffer
 * @param {object} [options] forwarded to the form (title, cwd, initialArgs)
 */
export async function promptForArgs(inputSchema, resultBuffer = null, options = {}) {
  return runArgForm(inputSchema, resultBuffer, options);
}

function agentToolName(index) {
  // Anthropic tool names have a restricted character set. Opaque IDs avoid
  // collisions when a server or tool itself contains the old "__" delimiter.
  return `mcp_tool_${index + 1}`;
}

export async function runStep(toolUses, toolByAgentName, confirmTool, executeTool, onToolResult) {
  const decisions = [];
  for (const use of toolUses) {
    const matched = toolByAgentName.get(use.name);
    if (!matched) {
      decisions.push({ use, matched: null, allowed: false, error: `Unknown tool "${use.name}"` });
      continue;
    }
    const allowed = await confirmTool(matched.__server, matched.name, use.input);
    decisions.push({ use, matched, allowed });
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("Cancelled by user (SIGINT)"));
  process.once("SIGINT", onSigint);
  try {
    const settled = await Promise.allSettled(decisions.map(async (decision) => {
      if (decision.error) return { tool_use_id: decision.use.id, content: `Error: ${decision.error}` };
      if (!decision.allowed) return { tool_use_id: decision.use.id, content: "User declined to run this tool call." };
      try {
        const result = await executeTool(decision.matched.__server, decision.matched.name, decision.use.input, { signal: controller.signal });
        await onToolResult?.({
          server: decision.matched.__server,
          tool: decision.matched.name,
          args: decision.use.input,
          result,
        });
        const content = (result.content ?? [])
          .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
          .join("\n") || JSON.stringify(result);
        return { tool_use_id: decision.use.id, content, is_error: Boolean(result.isError) };
      } catch (error) {
        return { tool_use_id: decision.use.id, content: `Error: ${error.message}`, is_error: true };
      }
    }));

    return settled.map((settlement, index) => settlement.status === "fulfilled"
      ? { type: "tool_result", ...settlement.value }
      : {
          type: "tool_result",
          tool_use_id: decisions[index].use.id,
          content: `Error: ${settlement.reason?.message ?? String(settlement.reason)}`,
          is_error: true,
        });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

export async function runAgentTurn({ messages, tools, apiKey, userQuery, confirmTool, executeTool, onToolResult }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey });
  const toolByAgentName = new Map();
  const toolDefs = tools.map((tool, index) => {
    const name = agentToolName(index);
    toolByAgentName.set(name, tool);
    return {
      name,
      description: `[${tool.__server}/${tool.name}]${tool.description ? ` ${tool.description}` : ""}`,
      input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      ...(index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    };
  });

  if (userQuery !== null) messages.push({ role: "user", content: userQuery });

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const request = {
      model: process.env.MCP_DEV_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages,
      ...(toolDefs.length ? { tools: toolDefs, tool_choice: { type: "auto" } } : {}),
    };
    const stream = anthropic.messages.stream(request);
    stream.on("text", (delta) => process.stdout.write(delta));
    const response = await stream.finalMessage();
    if (response.content.some((block) => block.type === "text")) process.stdout.write("\n");
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (!toolUses.length) {
      return {
        text: response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
        steps: step + 1,
      };
    }

    messages.push({
      role: "user",
      content: await runStep(toolUses, toolByAgentName, confirmTool, executeTool, onToolResult),
    });
  }

  return { text: `[stopped after ${MAX_AGENT_STEPS} tool-call steps without a final answer]`, steps: MAX_AGENT_STEPS };
}
