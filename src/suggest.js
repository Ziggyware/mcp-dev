import inquirer from "inquirer";
import { search, editor as editorPrompt } from "@inquirer/prompts";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { style } from "./colors.js";
import { resolveBackref } from "./resultBuffer.js";

export const CANCELLED = Symbol("promptForArgs:cancelled");
const SKIP = Symbol("promptForArgs:skip");
const MAX_RETRY = 3;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiledSchemaCache = new Map();

function getValidator(schema) {
  const key = JSON.stringify(schema);
  let validate = compiledSchemaCache.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiledSchemaCache.set(key, validate);
  }
  return validate;
}

function coerceScalar(value, schema) {
  if (schema.type === "number" || schema.type === "integer") {
    return typeof value === "number" ? value : Number(value);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

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
  let literalOverride;
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
    if (back.literal !== undefined) literalOverride = back.literal;
  }

  return coerceScalar(literalOverride ?? trimmed, schema);
}

async function promptJsonField(label, schema, resultBuffer, attempt = 0) {
  const { seed } = await inquirer.prompt([
    {
      type: "input",
      name: "seed",
      message: `${label} ${style.muted("(JSON" + (resultBuffer ? ", or !N / !N.path" : "") + " — blank opens an editor)")}`,
    },
  ]);

  const trimmed = seed.trim();
  let literalOverride;
  if (trimmed !== "" && resultBuffer) {
    const back = resolveBackref(trimmed, resultBuffer);
    if (back.matched) {
      if (back.error) {
        console.log(style.error(back.error));
        return promptJsonField(label, schema, resultBuffer, attempt);
      }
      return back.value;
    }
    if (back.literal !== undefined) literalOverride = back.literal;
  }

  const effective = literalOverride ?? trimmed;
  if (effective !== "") {
    try {
      return JSON.parse(effective);
    } catch {
      return openJsonEditor(label, effective, attempt);
    }
  }

  const skeleton = schema.default !== undefined
    ? JSON.stringify(schema.default, null, 2)
    : schema.type === "array" ? "[]" : "{}";
  return openJsonEditor(label, skeleton, attempt);
}

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

  const validate = getValidator(inputSchema);
  if (!validate(args)) {
    console.log(style.error("Arguments fail schema validation:"));
    for (const e of validate.errors) {
      console.log(style.error(`  ${e.instancePath || "(root)"} ${e.message}`));
    }
    return CANCELLED;
  }

  return args;
}

const MAX_AGENT_STEPS = 8;

async function runStep(toolUses, tools, confirmTool, executeTool) {
  const decisions = [];
  for (const use of toolUses) {
    const sep = use.name.indexOf("__");
    const server = sep === -1 ? undefined : use.name.slice(0, sep);
    const bareName = sep === -1 ? use.name : use.name.slice(sep + 2);
    const matched = tools.find((t) => t.name === bareName && t.__server === server);

    if (!matched) {
      decisions.push({ use, matched: null, allowed: false, error: `Unknown tool "${use.name}"` });
      continue;
    }
    const allowed = await confirmTool(matched.__server, use.name, use.input);
    decisions.push({ use, matched, allowed });
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("Cancelled by user (SIGINT)"));
  process.once("SIGINT", onSigint);

  let settled;
  try {
    settled = await Promise.allSettled(
      decisions.map(async (d) => {
        if (d.error) return { tool_use_id: d.use.id, content: `Error: ${d.error}` };
        if (!d.allowed) return { tool_use_id: d.use.id, content: "User declined to run this tool call." };
        try {
          const result = await executeTool(d.matched.__server, d.use.name, d.use.input, { signal: controller.signal });
          const content = (result.content ?? [])
            .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
            .join("\n") || JSON.stringify(result);
          return { tool_use_id: d.use.id, content };
        } catch (err) {
          return { tool_use_id: d.use.id, content: `Error: ${err.message}` };
        }
      })
    );
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? { type: "tool_result", ...s.value }
      : { type: "tool_result", tool_use_id: decisions[i].use.id, content: `Error: ${s.reason?.message ?? String(s.reason)}` }
  );
}

export async function runAgentTurn({ messages, tools, apiKey, userQuery, confirmTool, executeTool }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey });

  const toolDefs = tools.map((t, i) => ({
    name: `${t.__server}__${t.name}`,
    description: t.description ?? "",
    input_schema: t.inputSchema ?? { type: "object", properties: {} },
    ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));

  if (userQuery !== null) {
    messages.push({ role: "user", content: userQuery });
  }

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: toolDefs,
      tool_choice: { type: "auto" },
      messages,
    });
    stream.on("text", (delta) => process.stdout.write(delta));
    const response = await stream.finalMessage();
    if (response.content.some((b) => b.type === "text")) process.stdout.write("\n");

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return { text, steps: step + 1 };
    }

    const toolResults = await runStep(toolUses, tools, confirmTool, executeTool);
    messages.push({ role: "user", content: toolResults });
  }

  return { text: `[stopped after ${MAX_AGENT_STEPS} tool-call steps without a final answer]`, steps: MAX_AGENT_STEPS };
}