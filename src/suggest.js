import Ajv from "ajv";
import addFormats from "ajv-formats";
import { editor as editorPrompt } from "@inquirer/prompts";
import { style } from "./colors.js";
import { textInput, wordSearch } from "./prompts.js";
import { resolveBackref } from "./resultBuffer.js";

export const CANCELLED = Symbol("promptForArgs:cancelled");
const SKIP = Symbol("promptForArgs:skip");
const MAX_RETRY = 3;
export const MAX_AGENT_STEPS = 8;

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

export function validateArguments(inputSchema, args) {
  if (!inputSchema || typeof inputSchema !== "object") return { valid: true, errors: [] };
  try {
    const validate = getValidator(inputSchema);
    const valid = validate(args);
    return {
      valid: Boolean(valid),
      errors: valid ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`),
    };
  } catch (error) {
    // A malformed server-provided schema must not turn into an opaque crash.
    return { valid: false, errors: [`Unable to validate the server schema: ${error.message}`] };
  }
}

function schemaType(schema = {}) {
  if (Array.isArray(schema.type)) return schema.type.find((type) => type !== "null") ?? schema.type[0];
  return schema.type;
}

function schemaHint(schema = {}) {
  const details = [];
  if (schema.default !== undefined) details.push(`default: ${JSON.stringify(schema.default)}`);
  if (schema.format) details.push(schema.format);
  if (schema.minimum !== undefined) details.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) details.push(`max ${schema.maximum}`);
  if (schema.pattern) details.push(`pattern ${schema.pattern}`);
  return details.length ? ` [${details.join(", ")}]` : "";
}

function coerceScalar(value, schema) {
  const type = schemaType(schema);
  if (type === "number" || type === "integer") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Enter a finite number.");
    if (type === "integer" && !Number.isInteger(numeric)) throw new Error("Enter a whole number.");
    return numeric;
  }
  if (type === "null") {
    if (value === "null" || value === null) return null;
    throw new Error("Enter null.");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function validateScalarText(value, schema, isRequired) {
  const text = String(value ?? "").trim();
  if (!text) return isRequired ? "A value is required." : true;
  try {
    const coerced = coerceScalar(text, schema);
    const fieldValidation = validateArguments(schema, coerced);
    return fieldValidation.valid ? true : fieldValidation.errors[0] ?? "Invalid value.";
  } catch (error) {
    return error.message;
  }
}

function backrefHint(resultBuffer) {
  return resultBuffer ? style.muted(" (or !N / !N.path; \\! for a literal !)") : "";
}

async function promptScalarWithBackref(label, schema, isRequired, resultBuffer, attempt = 0) {
  const answer = await textInput({
    message: `${label}${schemaHint(schema)}${backrefHint(resultBuffer)}`,
    default: schema.default !== undefined ? String(schema.default) : undefined,
    validate: (value) => {
      const text = String(value ?? "").trim();
      // Resolve after submit so a stale/malformed reference can produce a
      // useful cache-specific error instead of being rejected as a number.
      if (resultBuffer && (resolveBackref(text, resultBuffer).matched || text.startsWith("\\!"))) return true;
      return validateScalarText(value, schema, isRequired);
    },
  });
  const trimmed = String(answer).trim();
  if (trimmed === "") return isRequired ? CANCELLED : SKIP;

  let literalOverride;
  if (resultBuffer) {
    const back = resolveBackref(trimmed, resultBuffer);
    if (back.matched) {
      if (back.error) {
        console.log(style.error(back.error));
        if (attempt >= MAX_RETRY - 1) return isRequired ? CANCELLED : SKIP;
        return promptScalarWithBackref(label, schema, isRequired, resultBuffer, attempt + 1);
      }
      try {
        return coerceScalar(back.value, schema);
      } catch (error) {
        console.log(style.error(error.message));
        if (attempt >= MAX_RETRY - 1) return isRequired ? CANCELLED : SKIP;
        return promptScalarWithBackref(label, schema, isRequired, resultBuffer, attempt + 1);
      }
    }
    if (back.literal !== undefined) literalOverride = back.literal;
  }

  try {
    return coerceScalar(literalOverride ?? trimmed, schema);
  } catch (error) {
    console.log(style.error(error.message));
    return attempt >= MAX_RETRY - 1 ? (isRequired ? CANCELLED : SKIP) : promptScalarWithBackref(label, schema, isRequired, resultBuffer, attempt + 1);
  }
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
  } catch (error) {
    console.log(style.error(`Invalid JSON: ${error.message}`));
    return openJsonEditor(label, text, attempt + 1);
  }
}

async function promptJsonField(label, schema, resultBuffer, attempt = 0) {
  const seed = await textInput({
    message: `${label} ${style.muted("(JSON" + (resultBuffer ? ", or !N / !N.path; \\! for literal !" : "") + " — blank opens an editor)")}`,
  });
  const trimmed = String(seed).trim();
  let literalOverride;
  if (trimmed && resultBuffer) {
    const back = resolveBackref(trimmed, resultBuffer);
    if (back.matched) {
      if (back.error) {
        console.log(style.error(back.error));
        return promptJsonField(label, schema, resultBuffer, attempt + 1);
      }
      return back.value;
    }
    if (back.literal !== undefined) literalOverride = back.literal;
  }

  const effective = literalOverride ?? trimmed;
  if (effective) {
    try {
      return JSON.parse(effective);
    } catch {
      return openJsonEditor(label, effective, attempt);
    }
  }

  const skeleton = schema.default !== undefined
    ? JSON.stringify(schema.default, null, 2)
    : schemaType(schema) === "array" ? "[]" : "{}";
  return openJsonEditor(label, skeleton, attempt);
}

function enumLabel(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function promptEnum(label, schema, isRequired) {
  const choices = schema.enum.map((value) => ({ value, name: enumLabel(value), label: enumLabel(value) }));
  if (!isRequired) choices.push({ value: SKIP, name: style.muted("(skip)"), label: "skip" });
  return wordSearch({
    message: `${label}${schemaHint(schema)}`,
    source: async (input) => {
      const needle = String(input ?? "").toLowerCase();
      return choices.filter((choice) => !needle || choice.label.toLowerCase().includes(needle));
    },
  });
}

async function promptBoolean(label, schema, isRequired) {
  const values = schema.default === false ? [false, true] : [true, false];
  const choices = values.map((value) => ({ value, name: String(value), label: String(value) }));
  // Optional booleans should not silently become true merely because Enter
  // accepted the first search result.
  if (!isRequired) choices.unshift({ value: SKIP, name: style.muted("(skip)"), label: "skip" });
  const defaultValue = schema.default;
  return wordSearch({
    message: `${label}${defaultValue !== undefined ? style.muted(` [default: ${defaultValue}]`) : ""}`,
    source: async (input) => {
      const needle = String(input ?? "").toLowerCase();
      return choices.filter((choice) => !needle || choice.label.includes(needle));
    },
  });
}

function labelFor(key, schema, isRequired) {
  const requirement = isRequired ? " (required)" : " (optional)";
  const description = schema.description ? ` — ${schema.description}` : "";
  return `${key}${requirement}${description}`;
}

async function collectArgs(inputSchema, resultBuffer) {
  if (!inputSchema || (!inputSchema.properties && schemaType(inputSchema) !== "object")) {
    const raw = await textInput({
      message: "Arguments (JSON, schema not recognized):",
      default: "{}",
      validate: (value) => {
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? true : "Arguments must be a JSON object.";
        } catch (error) {
          return `Invalid JSON: ${error.message}`;
        }
      },
    });
    return JSON.parse(raw);
  }

  const required = new Set(inputSchema.required ?? []);
  const args = {};
  for (const [key, rawSchema] of Object.entries(inputSchema.properties)) {
    const schema = rawSchema ?? {};
    const isRequired = required.has(key);
    const label = labelFor(key, schema, isRequired);
    const type = schemaType(schema);

    if (Array.isArray(schema.enum)) {
      const value = await promptEnum(label, schema, isRequired);
      if (value !== SKIP) args[key] = value;
      continue;
    }
    if (type === "boolean") {
      const value = await promptBoolean(label, schema, isRequired);
      if (value !== SKIP) args[key] = value;
      continue;
    }
    if (type === "array" || type === "object" || schema.oneOf || schema.anyOf) {
      const value = await promptJsonField(label, schema, resultBuffer);
      if (value === CANCELLED) return CANCELLED;
      args[key] = value;
      continue;
    }

    const value = await promptScalarWithBackref(label, schema, isRequired, resultBuffer);
    if (value === CANCELLED) return CANCELLED;
    if (value !== SKIP) args[key] = value;
  }
  return args;
}

export async function promptForArgs(inputSchema, resultBuffer = null) {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const args = await collectArgs(inputSchema, resultBuffer);
    if (args === CANCELLED) return CANCELLED;
    const validation = validateArguments(inputSchema, args);
    if (validation.valid) return args;

    console.log(style.error("Arguments fail schema validation:"));
    for (const error of validation.errors) console.log(style.error(`  ${error}`));
    if (attempt < MAX_RETRY - 1) console.log(style.muted("Please correct the arguments."));
  }
  console.log(style.warning(`Cancelled after ${MAX_RETRY} invalid attempts.`));
  return CANCELLED;
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
