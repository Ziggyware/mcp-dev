// src/jsonPrompt.js
//
// Inline multi-line JSON editor. Replaces the old "open $EDITOR/Notepad in a
// separate window and hope" flow with a real in-terminal editor: live syntax
// colouring, structural error positions, schema hints, indentation, and
// template insertion.

import { runPrompt } from "./inputPrompt.js";
import { colorizeJsonLine, parseJsonText, jsonTypeLabel, jsonValueSummary } from "./jsonText.js";
import { schemaHint, schemaType, schemaToTemplate, summarizeJson, validateArguments } from "./schema.js";
import { colors, marks, style } from "./colors.js";
import * as L from "./lineEditor.js";
import { cachedRefItems } from "./backrefs.js";

function constraintsFor(schema = {}) {
  const parts = [];
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  if (Array.isArray(schema.enum)) parts.push(`one of ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`);
  if (schema.minimum !== undefined) parts.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`max ${schema.maximum}`);
  if (schema.minLength !== undefined) parts.push(`min length ${schema.minLength}`);
  if (schema.maxLength !== undefined) parts.push(`max length ${schema.maxLength}`);
  if (schema.pattern) parts.push(`pattern ${schema.pattern}`);
  if (schema.format) parts.push(schema.format);
  return parts;
}

/**
 * Human-readable schema panel used by the JSON editor and the argument form.
 * Explains every property, its type, whether it is required, and constraints.
 */
export function schemaPanelLines(schema, { indent = "  ", depth = 0, maxDepth = 2 } = {}) {
  if (!schema || typeof schema !== "object") return [];
  const lines = [];
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(properties);
  if (!entries.length) {
    lines.push(colors.faint(`${indent}${schemaType(schema)} — no fixed properties`));
  }
  for (const [name, raw] of entries) {
    const field = raw ?? {};
    const marker = required.has(name) ? style.required("*") : " ";
    const type = style.muted(schemaType(field));
    const extra = constraintsFor(field);
    const description = field.description ? `  ${colors.faint(field.description)}` : "";
    lines.push(`${indent}${marker} ${style.schemaKey(name)} ${type}${extra.length ? ` ${colors.faint(`(${extra.join("; ")})`)}` : ""}${description}`);
    if (depth < maxDepth && field.properties && Object.keys(field.properties).length) {
      lines.push(...schemaPanelLines(field, { indent: `${indent}    `, depth: depth + 1, maxDepth }));
    }
    if (depth < maxDepth && field.items?.properties && Object.keys(field.items.properties).length) {
      lines.push(`${indent}    ${colors.faint("items:")}`);
      lines.push(...schemaPanelLines(field.items, { indent: `${indent}      `, depth: depth + 1, maxDepth }));
    }
  }
  return lines;
}

function indentOf(line) {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {object} options.schema
 * @param {string} [options.initialText]
 * @param {import("./resultBuffer.js").ResultBuffer} [options.resultBuffer]
 * @param {Function} [options.resolveRef] (text) => {matched, value, error}
 * @returns {Promise<{ok:true, value?:any, reference?:any, text:string}|{ok:false, reason:string}>}
 */
export async function promptJsonValue({
  label,
  schema = {},
  initialText = "",
  resultBuffer = null,
  resolveRef = null,
  history = null,
  message = "❯",
  hint = null,
  validateValue = null,
} = {}) {
  const type = schemaType(schema);
  const template = schemaToTemplate(schema);
  const effectiveSchema = schema.type ? schema : { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [], ...schema };

  const textRef = { current: initialText || template };

  function analyze(text) {
    const trimmed = text.trim();
    if (!trimmed) return { kind: "empty" };
    if (trimmed.startsWith("!") && resolveRef) {
      const resolved = resolveRef(trimmed);
      if (resolved?.matched) {
        if (resolved.error) return { kind: "ref-error", error: resolved.error };
        return { kind: "ref", value: resolved.value };
      }
      return { kind: "ref-unknown", error: `No cached result matches "${trimmed}". Type ! to list cached results.` };
    }
    const parsed = parseJsonText(text);
    if (!parsed.ok) return { kind: "invalid", ...parsed };
    const validation = validateArguments(effectiveSchema, parsed.value);
    if (!validation.valid) return { kind: "schema", errors: validation.errors };
    if (validateValue) {
      const verdict = validateValue(parsed.value);
      if (verdict !== true) return { kind: "custom", error: typeof verdict === "string" ? verdict : "Invalid value." };
    }
    return { kind: "valid", value: parsed.value };
  }

  function statusLines(state) {
    const analysis = analyze(state.line.text);
    const lines = [];
    if (analysis.kind === "empty") lines.push(colors.faint("  empty — Tab inserts a template"));
    else if (analysis.kind === "valid") {
      lines.push(`  ${marks.ok()} ${colors.success("valid JSON")} ${colors.faint(`· ${jsonTypeLabel(analysis.value)} · ${summarizeJson(analysis.value, { maxLength: 48 })}`)}`);
    } else if (analysis.kind === "ref") {
      lines.push(`  ${marks.ok()} ${colors.success("cached value")} ${colors.faint(`· ${jsonTypeLabel(analysis.value)} · ${summarizeJson(analysis.value, { maxLength: 48 })}`)}`);
    } else if (analysis.kind === "schema") {
      lines.push(`  ${marks.fail()} ${colors.error("valid JSON, but the schema rejects it:")}`);
      for (const error of analysis.errors.slice(0, 3)) lines.push(colors.error(`      ${error}`));
    } else if (analysis.kind === "invalid") {
      const where = `line ${analysis.line + 1}, column ${analysis.column + 1}`;
      lines.push(`  ${marks.fail()} ${colors.error(analysis.error)} ${colors.faint(`(${where})`)}`);
    } else {
      lines.push(`  ${marks.warn()} ${colors.warning(analysis.error)}`);
    }
    if (hint) lines.push(colors.faint(`  ${hint}`));
    return lines;
  }

  const header = [
    `${style.heading(label)} ${colors.faint(`— ${type}${schemaHint(schema)}`)}`,
    ...schemaPanelLines(effectiveSchema).slice(0, 10),
  ];

  const result = await runPrompt({
    title: header,
    message,
    initialText: textRef.current,
    submitKey: "ctrl+enter",
    allowNewline: true,
    menuSize: 6,
    history: null,
    status: { text: "Enter newline · Ctrl+Enter save · Tab indent/template · Esc cancel", tone: "info" },
    completions: async (text) => {
      if (!resultBuffer || !text.trim().startsWith("!")) return { items: [] };
      return { items: cachedRefItems(resultBuffer, text.trim().split(/\s/)[0]) };
    },
    decorateInput: (windowText, ctx) => {
      const wholeLines = textRef.current.split("\n");
      let state = false;
      for (let index = 0; index < ctx.index; index++) {
        state = colorizeJsonLine(wholeLines[index] ?? "", state).state;
      }
      const colored = colorizeJsonLine(windowText, state);
      const left = ctx.hiddenLeft > 0 ? colors.faint("…") : "";
      const right = ctx.hiddenRight > 0 ? colors.faint("…") : "";
      return { text: `${left}${colored.text}${right}`, caret: ctx.caretCol + (ctx.hiddenLeft > 0 ? 1 : 0) };
    },
    footer: (state) => {
      textRef.current = state.line.text;
      return statusLines(state);
    },
    preview: (state) => {
      const analysis = analyze(state.line.text);
      if (analysis.kind !== "invalid" && analysis.kind !== "schema") return [];
      if (analysis.kind === "schema") return [];
      // Point at the offending line when it is not the caret line.
      const lines = state.line.text.split("\n");
      const target = lines[analysis.line] ?? "";
      return [colors.faint("problem line:"), `  ${colors.error(target)}`];
    },
    hints: () => ["Tab indent / template", "Enter newline", "Ctrl+Enter save", "Esc cancel"],
    onKey: (event, api) => {
      const line = api.line;
      if (event.name === "tab") {
        if (!line.text.trim()) {
          api.replaceLine(template);
          return true;
        }
        if (event.shift) {
          const start = L.lineStartIndex(line.text, line.cursor);
          const match = /^ {2}/.exec(line.text.slice(start));
          if (match) {
            api.setLine({ text: line.text.slice(0, start) + line.text.slice(start + 2), cursor: Math.max(start, line.cursor - 2) });
          }
          return true;
        }
        // Indent: continue the current indentation.
        const start = L.lineStartIndex(line.text, line.cursor);
        const indent = indentOf(line.text.slice(start, L.lineEndIndex(line.text, line.cursor)));
        api.setLine(L.insertText(line, indent || "  "));
        return true;
      }
      if (event.name === "enter" && !event.ctrl && !event.meta) {
        const start = L.lineStartIndex(line.text, line.cursor);
        const indent = indentOf(line.text.slice(start, L.lineEndIndex(line.text, line.cursor)));
        const previous = line.text[line.cursor - 1];
        const extra = previous === "{" || previous === "[" || previous === "," ? "  " : "";
        api.setLine(L.insertText(line, `\n${indent}${extra}`));
        return true;
      }
      if (event.name === "escape") {
        api.close("cancel");
        return true;
      }
      return false;
    },
  });

  if (!result.ok) return { ok: false, reason: result.reason };
  const analysis = analyze(result.text);
  if (analysis.kind === "ref") return { ok: true, reference: analysis.value, text: result.text };
  if (analysis.kind === "valid") return { ok: true, value: analysis.value, text: result.text };
  const errors = analysis.errors ?? [analysis.error ?? "Invalid JSON."];
  return { ok: false, reason: "invalid", errors, text: result.text };
}

export { jsonValueSummary, parseJsonText };
