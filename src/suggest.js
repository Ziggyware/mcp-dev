import inquirer from "inquirer";
import { search } from "@inquirer/prompts";

export async function promptForArgs(inputSchema) {
  if (!inputSchema || inputSchema.type !== "object" || !inputSchema.properties) {
    const { raw } = await inquirer.prompt([
      { type: "input", name: "raw", message: "Arguments (JSON, schema not recognized):", default: "{}" },
    ]);
    return JSON.parse(raw);
  }

  const required = new Set(inputSchema.required ?? []);
  const args = {};

  for (const [key, schema] of Object.entries(inputSchema.properties)) {
    const isRequired = required.has(key);
    const label = `${key}${isRequired ? " (required)" : " (optional)"}${schema.description ? " - " + schema.description : ""}`;

    if (Array.isArray(schema.enum)) {
      const choices = isRequired ? schema.enum : [...schema.enum, "(skip)"];
      const value = await search({
        message: label,
        source: async (input) => {
          const filtered = input ? choices.filter((c) => c.toLowerCase().includes(input.toLowerCase())) : choices;
          return filtered.map((c) => ({ value: c, name: c }));
        },
      });
      if (value !== "(skip)") args[key] = value;
      continue;
    }

    if (schema.type === "boolean") {
      const { value } = await inquirer.prompt([
        { type: "confirm", name: "value", message: label, default: schema.default ?? false },
      ]);
      args[key] = value;
      continue;
    }


    // In promptForArgs's scalar-field branch, replace the isPathLike branching
    // with a single unconditional path (no special-casing path-like fields at
    // all):
    const { value } = await inquirer.prompt([
      {
        type: "input",
        name: "value",
        message: label,
        default: schema.default !== undefined ? String(schema.default) : undefined,
        validate: (v) => {
          if (isRequired && v.trim() === "") return null; // handled by CANCELLED check below, not here
          return true;
        },
      },
    ]);

    if (value.trim() === "") {
      if (isRequired) return CANCELLED;
      continue;
    }

    if (value === "" && !isRequired) continue;
    if (schema.type === "number" || schema.type === "integer") {
      args[key] = Number(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

// Sentinel object (not a string/null) so a legitimate tool result that
// happens to be null/"" can never be mistaken for cancellation by identity
// check. Exported so session.js's loop can check `result === CANCELLED`.
export const CANCELLED = Symbol("promptForArgs:cancelled");
const MAX_AGENT_STEPS = 8;

// Runs one user turn to completion against a persistent `messages` array
// (mutated in place -- callers keep this across turns for real memory).
// Loops: send messages -> if model returns tool_use block(s), confirm each
// via `confirmTool`, execute via `executeTool`, feed results back as
// tool_result blocks, repeat -- until the model returns a turn with no
// tool_use blocks, or MAX_AGENT_STEPS is hit (bounds runaway loops; a model
// stuck re-calling a tool cannot spin forever).
export async function runAgentTurn({ messages, tools, apiKey, userQuery, confirmTool, executeTool }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey });

  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema ?? { type: "object", properties: {} },
  }));

  messages.push({ role: "user", content: userQuery });

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: toolDefs,
      tool_choice: { type: "auto" },
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return { text, steps: step + 1 };
    }

    const toolResults = [];
    for (const use of toolUses) {
      const matched = tools.find((t) => t.name === use.name);
      let resultContent;
      try {
        if (!matched) throw new Error(`Unknown tool "${use.name}"`);
        const allowed = await confirmTool(matched.__server, use.name, use.input);
        if (!allowed) {
          resultContent = "User declined to run this tool call.";
        } else {
          const result = await executeTool(matched.__server, use.name, use.input);
          resultContent = (result.content ?? [])
            .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
            .join("\n") || JSON.stringify(result);
        }
      } catch (err) {
        resultContent = `Error: ${err.message}`;
      }
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: resultContent });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { text: `[stopped after ${MAX_AGENT_STEPS} tool-call steps without a final answer]`, steps: MAX_AGENT_STEPS };
}