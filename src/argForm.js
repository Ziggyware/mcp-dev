// src/argForm.js
//
// The argument form. Every tool call is collected as a sequence of focused
// fields instead of a wall of prompts:
//
//   * required fields first, optional fields skippable,
//   * Shift+Tab walks back to the previous field,
//   * path-like fields open the filesystem navigator,
//   * object/array fields open the inline JSON editor (no external editor),
//   * every text field can reuse a cached result with !n / !n.path,
//   * a live summary shows what has been filled in so far.

import { runPrompt } from "./inputPrompt.js";
import { promptJsonValue, schemaPanelLines } from "./jsonPrompt.js";
import { promptPathValue } from "./pathPrompt.js";
import { cachedRefItems } from "./backrefs.js";
import { resolveBackref } from "./resultBuffer.js";
import {
  coerceScalar,
  isJsonField,
  isPathField,
  schemaHint,
  schemaType,
  summarizeJson,
  validateArguments,
  validateScalarText,
} from "./schema.js";
import { colors, marks, style } from "./colors.js";
import { rankByFuzzy } from "./fuzzy.js";

export const CANCELLED = Symbol("argForm:cancelled");
const SKIP = Symbol("argForm:skip");
const BACK = Symbol("argForm:back");
const BACK_KEY = "back";

/** Shift+Tab handler shared by every field: ask the form to step back. */
const backHandler = (api) => { api.close(BACK_KEY); };
const MAX_RETRY = 3;

function labelFor(key, schema, isRequired, index, total) {
  const requirement = isRequired ? style.required("required") : colors.faint("optional");
  const description = schema.description ? `  ${colors.faint(schema.description)}` : "";
  return `${style.heading(`[${index + 1}/${total}]`)} ${style.schemaKey(key)} ${requirement}${description}${schemaHint(schema) ? colors.faint(`  ${schemaHint(schema)}`) : ""}`;
}

function summaryPanel(fields, values, activeIndex) {
  const lines = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const value = values[field.key];
    const filled = value !== undefined;
    const marker = filled ? marks.ok() : index === activeIndex ? marks.pointer() : colors.faint("·");
    const name = filled ? style.schemaKey(field.key) : colors.faint(field.key);
    let display = "";
    if (filled) {
      display = typeof value === "string" ? value : summarizeJson(value, { maxLength: 42 });
      if (display.length > 44) display = `${display.slice(0, 43)}…`;
      display = colors.body(display);
    } else if (!field.isRequired) {
      display = colors.faint("(will be omitted)");
    }
    lines.push(`  ${marker} ${name}${filled ? ` ${colors.faint("=")} ${display}` : display ? `  ${display}` : ""}`);
  }
  return lines;
}

function optionItems(options, { includeSkip, skipFirst = false, skipLabel = "(skip)" }) {
  const items = options.map((option) => {
    // Accept plain strings as well as {value,label,description} objects so the
    // helper stays easy to test and to reuse for boolean rows.
    const entry = typeof option === "string" || typeof option === "number" || typeof option === "boolean"
      ? { value: option }
      : option ?? {};
    return {
      label: String(entry.label ?? entry.value),
      insertText: entry.value,
      description: entry.description ?? "",
      kind: "hint",
      complete: true,
    };
  });
  if (includeSkip) {
    const skip = { label: style.muted(skipLabel), insertText: SKIP, description: "leave this field out", kind: "hint", complete: true, skip: true };
    if (skipFirst) items.unshift(skip);
    else items.push(skip);
  }
  return items;
}

/**
 * Map what the user submitted onto one of the offered options. Empty input
 * takes the first option (so Enter-on-empty skips an optional field), exact
 * matches win, and otherwise the closest match is used instead of silently
 * letting a typo through.
 */
function resolveOptionValue(items, text) {
  const value = String(text ?? "").trim();
  if (!value) return items[0] ? items[0].insertText : null;
  const lower = value.toLowerCase();
  const exact = items.find((item) => String(item.insertText).toLowerCase() === lower || String(item.label).toLowerCase() === lower);
  if (exact) return exact.insertText;
  // Cards carry styled labels; match on the insert text so colour codes never
  // break a fuzzy match, and ignore case: enum values are identifiers, not
  // case-sensitive words.
  const best = rankByFuzzy(items, lower, { key: (item) => String(item.insertText ?? item.label).toLowerCase() })[0];
  if (best) return best.item.insertText;
  return text;
}

async function promptEnumField({ key, schema, isRequired, header, footer }) {
  // Shift+Tab steps back to the previous field, so an optional field can be
  // reached again after being skipped.
  const items = optionItems(
    schema.enum.map((value) => ({ value, label: typeof value === "string" ? value : JSON.stringify(value) })),
    { includeSkip: !isRequired, skipFirst: true }
  );
  const result = await runPrompt({
    title: header,
    message: () => `${marks.arrow()} ${style.body(key)}`,
    menuSize: 8,
    footer,
    status: { text: "↑/↓ choose · Enter accept · Esc cancel", tone: "info" },
    completions: (text) => ({ items: rankByFuzzy(items, text, { key: (item) => item.label }).map(({ item, indices }) => ({ ...item, indices })) }),
    hints: () => ["↑/↓ choose", "Enter accept", "Shift+Tab back", "Esc cancel"],
    onShiftTab: backHandler,
  });
  if (!result.ok) return result.reason === BACK_KEY ? BACK : CANCELLED;
  const resolved = resolveOptionValue(items, result.text);
  if (resolved === SKIP) return SKIP;
  return resolved === null ? (isRequired ? CANCELLED : SKIP) : resolved;
}

async function promptBooleanField({ key, schema, isRequired, header, footer, defaultValue }) {
  const values = defaultValue === false ? [false, true] : [true, false];
  const items = optionItems(values.map((value) => ({ value, label: String(value) })), { includeSkip: !isRequired, skipFirst: true });
  const result = await runPrompt({
    title: header,
    message: () => `${marks.arrow()} ${style.body(key)}`,
    menuSize: 4,
    footer,
    status: { text: "↑/↓ choose · Enter accept · Esc cancel", tone: "info" },
    completions: (text) => ({ items: rankByFuzzy(items, text, { key: (item) => item.label }).map(({ item, indices }) => ({ ...item, indices })) }),
    hints: () => ["↑/↓ choose", "Enter accept", "Shift+Tab back", "Esc cancel"],
    onShiftTab: backHandler,
  });
  if (!result.ok) return result.reason === BACK_KEY ? BACK : CANCELLED;
  const resolved = resolveOptionValue(items, result.text);
  if (resolved === SKIP) return SKIP;
  if (resolved === true || resolved === "true") return true;
  if (resolved === false || resolved === "false") return false;
  if (resolved === null) return isRequired ? CANCELLED : SKIP;
  console.log(style.error(`"${result.text}" is not a boolean — enter true or false.`));
  return CANCELLED;
}

/**
 * A single text field: scalar values, cached references, and (when the schema
 * looks like a path) the filesystem navigator.
 */
async function promptScalarField({ key, schema, isRequired, resultBuffer, header, footer, prefill, cwd, attempt = 0 }) {
  const wantsPath = isPathField(key, schema);
  const initialText = prefill === undefined || prefill === null ? "" : String(prefill);

  if (wantsPath) {
    const result = await promptPathValue({
      label: `${key}${isRequired ? " (required)" : " (optional)"}`,
      schema,
      baseDir: cwd,
      mode: /dir|folder|root/i.test(key) ? "dir" : "any",
      initialText,
    });
    if (!result.ok) return CANCELLED;
    const text = String(result.text).trim();
    if (!text) return isRequired ? CANCELLED : SKIP;
    return text;
  }

  const backrefValidate = (value) => {
    const text = String(value ?? "").trim();
    if (resultBuffer && (resolveBackref(text, resultBuffer).matched || text.startsWith("\\!"))) return true;
    return validateScalarText(value, schema, isRequired);
  };

  const result = await runPrompt({
    title: header,
    message: () => `${marks.arrow()} ${style.body(key)}`,
    initialText,
    footer,
    menuSize: 6,
    onShiftTab: backHandler,
    status: resultBuffer?.list().length
      ? { text: `type ! to reuse a cached result (${resultBuffer.list().length} available)`, tone: "info" }
      : null,
    completions: (text) => {
      const trimmed = String(text ?? "").trim();
      if (!resultBuffer || !trimmed.startsWith("!")) return { items: [] };
      return { items: cachedRefItems(resultBuffer, trimmed) };
    },
    hints: () => [
      "Enter accept",
      isRequired ? "" : "Enter on empty skips",
      "Shift+Tab previous",
      resultBuffer?.list().length ? "! cached values" : "",
      "Esc cancel",
    ].filter(Boolean),
    validate: backrefValidate,
    onKey: (event, api) => {
      if (event.name === "enter" && !api.line.text.trim() && !isRequired) {
        void api.submit("");
        return true;
      }
      return false;
    },
  });
  if (!result.ok) return result.reason === BACK_KEY ? BACK : CANCELLED;
  const trimmed = String(result.text).trim();
  if (trimmed === "") return isRequired ? CANCELLED : SKIP;

  let literalOverride;
  if (resultBuffer) {
    const back = resolveBackref(trimmed, resultBuffer);
    if (back.matched) {
      if (back.error) {
        console.log(style.error(back.error));
        if (attempt >= MAX_RETRY - 1) return isRequired ? CANCELLED : SKIP;
        return promptScalarField({ key, schema, isRequired, resultBuffer, header, footer, defaultValue, cwd, attempt: attempt + 1 });
      }
      try {
        return coerceScalar(back.value, schema);
      } catch (error) {
        console.log(style.error(error.message));
        if (attempt >= MAX_RETRY - 1) return isRequired ? CANCELLED : SKIP;
        return promptScalarField({ key, schema, isRequired, resultBuffer, header, footer, defaultValue, cwd, attempt: attempt + 1 });
      }
    }
    if (back.literal !== undefined) literalOverride = back.literal;
  }

  try {
    return coerceScalar(literalOverride ?? trimmed, schema);
  } catch (error) {
    console.log(style.error(error.message));
    if (attempt >= MAX_RETRY - 1) return isRequired ? CANCELLED : SKIP;
    return promptScalarField({ key, schema, isRequired, resultBuffer, header, footer, defaultValue, cwd, attempt: attempt + 1 });
  }
}

async function promptJsonField({ key, schema, isRequired, resultBuffer, header, footer, defaultValue }) {
  const initial = defaultValue === undefined
    ? ""
    : typeof defaultValue === "string" ? defaultValue : JSON.stringify(defaultValue, null, 2);
  const result = await promptJsonValue({
    label: `${key}${isRequired ? " (required)" : " (optional)"}`,
    schema,
    initialText: initial,
    resultBuffer,
    resolveRef: (text) => resolveBackref(text, resultBuffer),
  });
  if (!result.ok) {
    if (result.reason === "cancel") return CANCELLED;
    if (result.reason === "back") return BACK;
    console.log(style.error(`Invalid JSON for "${key}": ${(result.errors ?? []).join("; ")}`));
    return isRequired ? CANCELLED : SKIP;
  }
  if (result.reference !== undefined) return result.reference;
  return result.value;
}

/**
 * Collect arguments for one tool.
 *
 * @param {object} inputSchema
 * @param {import("./resultBuffer.js").ResultBuffer} resultBuffer
 * @param {object} [options]
 * @returns {Promise<object|symbol>} the arguments object or CANCELLED
 */
export async function promptForArgs(inputSchema, resultBuffer = null, options = {}) {
  const {
    title = null,
    cwd = process.cwd(),
    initialArgs = null,
    allowSkipAll = true,
  } = options;

  const schema = inputSchema && typeof inputSchema === "object" ? inputSchema : {};
  const properties = schema.properties ?? null;

  if (!properties && schemaType(schema) !== "object") {
    const result = await promptJsonValue({
      label: title ?? "Arguments",
      schema,
      initialText: initialArgs ? JSON.stringify(initialArgs, null, 2) : "",
      resultBuffer,
      resolveRef: (text) => resolveBackref(text, resultBuffer),
      hint: "the server did not publish an object schema — enter the JSON arguments directly",
    });
    if (!result.ok) return CANCELLED;
    if (result.reference !== undefined) return result.reference;
    if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
      console.log(style.error("Arguments must be a JSON object."));
      return CANCELLED;
    }
    return result.value;
  }

  const required = new Set(schema.required ?? []);
  const entries = Object.entries(properties ?? {});
  if (!entries.length) return {};

  const ordered = [
    ...entries.filter(([key]) => required.has(key)),
    ...entries.filter(([key]) => !required.has(key)),
  ];

  const fields = ordered.map(([key, rawSchema]) => ({
    key,
    schema: rawSchema ?? {},
    isRequired: required.has(key),
  }));
  const values = {};
  if (initialArgs && typeof initialArgs === "object") {
    for (const field of fields) {
      if (initialArgs[field.key] !== undefined) values[field.key] = initialArgs[field.key];
    }
  }

  const baseTitle = [
    title ? style.heading(title) : style.heading("Tool arguments"),
    ...schemaPanelLines(schema, { maxDepth: 1 }).slice(0, 8),
  ];

  let index = 0;
  while (index < fields.length) {
    const field = fields[index];
    const { key, schema: fieldSchema, isRequired } = field;
    const header = [...baseTitle, "", labelFor(key, fieldSchema, isRequired, index, fields.length)];
    const footer = () => ["", ...summaryPanel(fields, values, index)];

    const prefilled = values[key] !== undefined;
    // Going back over a field must not lose what was already entered.
    const prefill = prefilled ? values[key] : undefined;
    const schemaDefault = prefilled ? undefined : fieldSchema.default;
    const type = schemaType(fieldSchema);
    let value;

    if (Array.isArray(fieldSchema.enum)) {
      value = await promptEnumField({ key, schema: fieldSchema, isRequired, header, footer });
    } else if (type === "boolean") {
      value = await promptBooleanField({ key, schema: fieldSchema, isRequired, header, footer, defaultValue: prefill ?? schemaDefault });
    } else if (isJsonField(key, fieldSchema)) {
      value = await promptJsonField({ key, schema: fieldSchema, isRequired, resultBuffer, header, footer, defaultValue: prefill ?? schemaDefault });
    } else {
      value = await promptScalarField({
        key,
        schema: fieldSchema,
        isRequired,
        resultBuffer,
        header,
        footer,
        prefill: prefill ?? schemaDefault,
        cwd,
      });
    }

    if (value === BACK) {
      // Shift+Tab: step back to the previous field, keeping everything filled.
      index = Math.max(0, index - 1);
      continue;
    }

    if (value === CANCELLED) {
      console.log(colors.faint("Cancelled."));
      return CANCELLED;
    }

    if (value === SKIP) {
      delete values[key];
    } else {
      values[key] = value;
    }
    index += 1;
  }

  if (!allowSkipAll) {
    // still fine — schema validation below reports missing required fields
  }

  const validation = validateArguments(schema, values);
  if (validation.valid) return values;

  console.log(style.error("Arguments fail schema validation:"));
  for (const error of validation.errors) console.log(style.error(`  ${error}`));
  return CANCELLED;
}

/** Human summary used by approval screens and /history-style listings. */
export function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args)
    .map(([key, value]) => {
      // Clip long strings too: an approval screen should stay one readable
      // line even when a pasted paragraph is one of the arguments.
      const shown = typeof value === "string"
        ? summarizeJson(value, { maxLength: 24 }).replace(/^"|"$/g, "")
        : summarizeJson(value, { maxLength: 24 });
      return `${key}=${shown}`;
    })
    .join(" ");
}

export { SKIP, optionItems, resolveOptionValue };
