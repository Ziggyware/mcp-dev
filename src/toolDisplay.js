import { colors, style } from "./colors.js";
import { clipText, terminalColumns } from "./terminal.js";

function schemaType(schema = {}) {
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type) return schema.type;
  if (schema.const !== undefined) return "const";
  if (schema.oneOf || schema.anyOf) return "variant";
  if (schema.enum) return "enum";
  return "any";
}

function constraints(schema = {}) {
  const parts = [];
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.map((value) => JSON.stringify(value)).join(", ");
    parts.push(`one of ${values}`);
  }
  if (schema.const !== undefined) parts.push(`must be ${JSON.stringify(schema.const)}`);
  if (schema.minimum !== undefined) parts.push(`≥ ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`≤ ${schema.maximum}`);
  if (schema.minLength !== undefined) parts.push(`min length ${schema.minLength}`);
  if (schema.maxLength !== undefined) parts.push(`max length ${schema.maxLength}`);
  if (schema.pattern) parts.push(`pattern ${schema.pattern}`);
  if (schema.format) parts.push(schema.format);
  if (schema.deprecated) parts.push("deprecated");
  return parts;
}

function propertyLines(properties, required, { indent = "  ", depth = 0, width = terminalColumns() } = {}) {
  const lines = [];
  for (const [name, schema] of Object.entries(properties ?? {})) {
    const marker = required.has(name) ? style.required("*") : " ";
    const type = style.muted(schemaType(schema));
    const extra = constraints(schema);
    const description = schema.description ? ` — ${schema.description}` : "";
    const suffix = extra.length ? ` (${extra.join("; ")})` : "";
    lines.push(`${indent}${marker} ${colors.cyan(name)}: ${type}${style.muted(suffix)}${description ? style.muted(description) : ""}`);

    if (depth < 1 && schema.type === "object" && schema.properties) {
      lines.push(...propertyLines(schema.properties, new Set(schema.required ?? []), { indent: `${indent}    `, depth: depth + 1, width }));
    }
    if (depth < 1 && schema.type === "array" && schema.items?.properties) {
      lines.push(`${indent}    ${style.muted("items:")}`);
      lines.push(...propertyLines(schema.items.properties, new Set(schema.items.required ?? []), { indent: `${indent}      `, depth: depth + 1, width }));
    }
  }
  return lines;
}

export function formatTool(tool, { width = terminalColumns() } = {}) {
  const name = style.toolName(tool.name);
  const description = tool.description ? style.muted(` — ${clipText(tool.description, Math.max(24, width - 8))}`) : "";
  const lines = [`${name}${description}`];
  const schema = tool.inputSchema;
  const properties = schema?.properties;
  if (properties && Object.keys(properties).length) {
    lines.push(...propertyLines(properties, new Set(schema.required ?? []), { width }));
  } else {
    lines.push(style.muted("  (no input parameters)"));
  }
  return lines.join("\n");
}

export function formatTools(tools, options = {}) {
  if (!tools?.length) return style.muted("No tools reported by this server.");
  return tools.map((tool) => formatTool(tool, options)).join("\n\n");
}

export function toolNames(tools) {
  return (tools ?? []).map((tool) => tool.name).join("\n") + ((tools ?? []).length ? "\n" : "");
}

export { schemaType, constraints };
