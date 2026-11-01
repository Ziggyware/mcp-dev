// src/suggest.js
//
// Agent execution (planning + tool dispatch) plus the argument-form entry
// points. Prompting lives in argForm.js / jsonPrompt.js / pathPrompt.js; the
// functions here are re-exported so existing callers keep working.
//
// Two brains are supported: Anthropic (streaming Messages API) and any
// OpenAI-compatible endpoint — notably the nokey-router, which needs no API
// key. Two tool exposures are supported:
//
//   hooks (default)  the 20 progressive-disclosure hooks from agentHooks.js;
//                    the model zooms L1 → L2 → L3 → execute on demand.
//   direct (legacy)  every server tool exposed with its full schema up front
//                    (runAgentTurn({ tools }) — the pre-hooks behavior).

import { promptForArgs as runArgForm, CANCELLED as FORM_CANCELLED } from "./argForm.js";
import { validateArguments } from "./schema.js";
import { runAgentTurnOpenAI, OPENAI_AGENT_STEPS } from "./openaiAgent.js";

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

export async function runAgentTurn({
  messages,
  tools,
  hookSet = null,
  brain = null,
  apiKey = null,
  userQuery,
  system = null,
  confirmTool,
  executeTool,
  onToolResult,
  maxSteps,
}) {
  // Back-compat: callers that only pass apiKey get the Anthropic brain.
  const effectiveBrain = brain ?? (apiKey ? { kind: "anthropic", apiKey } : null);
  if (!effectiveBrain) throw new Error("No agent brain configured. Set ANTHROPIC_API_KEY or rely on the nokey-router.");

  if (effectiveBrain.kind === "openai") {
    const toolDefs = hookSet ? hookSet.defs : (tools ?? []).map((tool, index) => ({
      name: agentToolName(index),
      description: `[${tool.__server}/${tool.name}]${tool.description ? ` ${tool.description}` : ""}`,
      input_schema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
    const dispatch = hookSet
      ? (name, input) => hookSet.run(name, input)
      : async (name, input) => {
          const matched = tools[Number(/^mcp_tool_(\d+)$/.exec(name)?.[1]) - 1];
          if (!matched) return { content: `Unknown tool "${name}"`, is_error: true };
          const allowed = await confirmTool(matched.__server, matched.name, input);
          if (!allowed) return { content: "User declined to run this tool call." };
          try {
            const result = await executeTool(matched.__server, matched.name, input, {});
            await onToolResult?.({ server: matched.__server, tool: matched.name, args: input, result });
            const content = (result.content ?? []).map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n") || JSON.stringify(result);
            return { content, is_error: Boolean(result.isError) };
          } catch (error) {
            return { content: `Error: ${error.message}`, is_error: true };
          }
        };
    return runAgentTurnOpenAI({
      messages,
      toolDefs,
      brain: effectiveBrain,
      userQuery,
      system,
      dispatch,
      maxSteps: maxSteps ?? (hookSet ? OPENAI_AGENT_STEPS : MAX_AGENT_STEPS),
    });
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: effectiveBrain.apiKey });
  const toolByAgentName = new Map();

  let toolDefs;
  if (hookSet) {
    toolDefs = hookSet.defs.map((def) => ({ ...def }));
  } else {
    toolDefs = (tools ?? []).map((tool, index) => {
      const name = agentToolName(index);
      toolByAgentName.set(name, tool);
      return {
        name,
        description: `[${tool.__server}/${tool.name}]${tool.description ? ` ${tool.description}` : ""}`,
        input_schema: tool.inputSchema ?? { type: "object", properties: {} },
        ...(index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      };
    });
  }

  const dispatchToolUse = async (use) => {
    if (hookSet) {
      const outcome = await hookSet.run(use.name, use.input ?? {});
      return { tool_use_id: use.id, content: outcome.content, is_error: Boolean(outcome.is_error) };
    }
    const results = await runStep([use], toolByAgentName, confirmTool, executeTool, onToolResult);
    return results[0];
  };

  if (userQuery !== null) messages.push({ role: "user", content: userQuery });

  const stepLimit = maxSteps ?? (hookSet ? 12 : MAX_AGENT_STEPS);
  for (let step = 0; step < stepLimit; step++) {
    const request = {
      model: effectiveBrain.model || process.env.MCP_DEV_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages,
      ...(system ? { system } : {}),
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

    const content = [];
    for (const use of toolUses) content.push(await dispatchToolUse(use));
    messages.push({ role: "user", content });
  }

  return { text: `[stopped after ${stepLimit} tool-call steps without a final answer]`, steps: stepLimit };
}
