import inquirer from "inquirer";
import { search, editor as editorPrompt } from "@inquirer/prompts";
import { style } from "./colors.js";
import { resolveBackref } from "./resultBuffer.js";

// Sentinel objects (not strings/null) so a legitimate tool result that
// happens to be null/"" can never be mistaken for cancellation or
// skip-this-field by identity check. CANCELLED is exported so callers
// (session.js's loop, promptForArgs itself) can check `=== CANCELLED`.
export const CANCELLED = Symbol("promptForArgs:cancelled");
const SKIP = Symbol("promptForArgs:skip");
const MAX_RETRY = 3;

function coerceScalar(value, schema) {
  if (schema.type === "number" || schema.type === "integer") {
    return typeof value === "number" ? value : Number(value);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Scalar (string/number/integer) fields. `resultBuffer` is optional --
// omitted entirely by index.js's one-shot `call` command (no session, no
// buffer to reference), passed by session.js's tool-call flow. When
// present, a typed value matching "!!"/"!<n>"/"!<n>.<path>" is resolved
// against the buffer instead of taken literally; see resultBuffer.js for
// the collision failure mode (literal args that start with "!").
async function promptScalarWithBackref(label, schema, isRequired, resultBuffer, attempt = 0) {
  const { value } = await inquirer.prompt([
    {
      type: "input",
      name: "value",
      message: resultBuffer ? `${label} ${style.muted("(or !N / !N.path)")}` : label,
      default: schema.default !== undefined ? String(schema.default) : undefined,
    },
  ]);

  const trimmed = value.trim();
  if (trimmed === "") return isRequired ? CANCELLED : SKIP;

  if (resultBuffer) {
    const back = resolveBackref(trimmed, resultBuffer);
    if (back.matched) {
      if (back.error) {
        console.log(style.error(back.error));
        if (attempt >= MAX_RETRY - 1) {
          console.log(style.warning(`Giving up after ${MAX_RETRY} attempts.`));
          return isRequired ? CANCELLED : SKIP;
        }
        return promptScalarWithBackref(label, schema, isRequired, resultBuffer, attempt + 1);
      }
      return coerceScalar(back.value, schema);
    }
  }

  return coerceScalar(trimmed, schema);
}

// Object/array fields (new — this is the fix for the README's Known
// Limitations entry: "promptForArgs has no branch for array- or
// object-typed schema properties ... falls through to a plain string
// prompt"). Scope, stated plainly rather than overclaimed: this makes
// producing valid JSON *easier* (external-editor UX, syntax-error retry,
// backref/dot-path substitution of a whole previous result) -- it does
// NOT add field-by-field sub-schema prompting for nested object shapes.
// A tool with a deeply nested required object still requires the user to
// write that JSON by hand, just now in a real editor instead of a
// single-line terminal prompt.
async function promptJsonField(label, schema, resultBuffer, attempt = 0) {
  const { seed } = await inquirer.prompt([
    {
      type: "input",
      name: "seed",
      message: `${label} ${style.muted("(JSON" + (resultBuffer ? ", or !N / !N.path" : "") + " — blank opens an editor)")}`,
    },
  ]);

  const trimmed = seed.trim();

  if (trimmed !== "" && resultBuffer) {
    const back = resolveBackref(trimmed, resultBuffer);
    if (back.matched) {
      if (back.error) {
        console.log(style.error(back.error));
        return promptJsonField(label, schema, resultBuffer, attempt);
      }
      return back.value; // already a parsed JS value pulled from cached JSON
    }
  }

  if (trimmed !== "") {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall into the editor pre-filled with what they typed, so a typo
      // gets fixed in place instead of forcing a full restart.
      return openJsonEditor(label, trimmed, attempt);
    }
  }

  const skeleton = schema.default !== undefined
    ? JSON.stringify(schema.default, null, 2)
    : schema.type === "array" ? "[]" : "{}";
  return openJsonEditor(label, skeleton, attempt);
}

// [unverified — check before relying on this]: exact default-editor
// resolution order (EDITOR/VISUAL env vars, vi/notepad fallback) is
// @inquirer/external-editor's behavior, not reimplemented or verified
// here beyond confirming the "editor" export exists and accepts
// {message, default, postfix} (checked against the installed package in
// this session — see the verification note in the accompanying reply).
async function openJsonEditor(label, seedText, attempt) {
  if (attempt >= MAX_RETRY) {
    console.log(style.warning(`Giving up after ${MAX_RETRY} invalid JSON attempts.`));
    return CANCELLED;
  }
  const text = await editorPrompt({
    message: `Edit JSON for ${label}`,
    default: seedText,
    postfix: ".json",
  });
  try {
    return JSON.parse(text);
  } catch (err) {
    console.log(style.error(`Invalid JSON: ${err.message}`));
    return openJsonEditor(label, text, attempt + 1);
  }
}

export async function promptForArgs(inputSchema, resultBuffer = null) {
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

    if (schema.type === "array" || schema.type === "object") {
      const value = await promptJsonField(label, schema, resultBuffer);
      if (value === CANCELLED) return CANCELLED;
      args[key] = value;
      continue;
    }

    const value = await promptScalarWithBackref(label, schema, isRequired, resultBuffer);
    if (value === CANCELLED) return CANCELLED;
    if (value === SKIP) continue;
    args[key] = value;
  }
  return args;
}

// Sentinel export retained under its original name/position for anything
// importing CANCELLED the way the pre-existing code did.
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