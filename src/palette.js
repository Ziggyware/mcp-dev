// src/palette.js
//
// Formatting helpers shared by the palette, the completion menu, and the tool
// listings. The interactive palette itself now lives in sessionPrompt.js and
// sessionInput.js; the command metadata lives in commands.js so the palette,
// `/help`, and the README cannot drift apart.

export { BUILTIN_COMMANDS, BUILTIN_COMMAND_DESCRIPTIONS, SESSION_COMMANDS } from "./commands.js";

export function formatParamHint(inputSchema) {
  if (!inputSchema?.properties) return "";
  const required = new Set(inputSchema.required ?? []);
  return Object.entries(inputSchema.properties).map(([key, schema]) => {
    const requirement = required.has(key) ? "*" : "";
    const type = Array.isArray(schema.type) ? schema.type.join("|") : schema.type ?? "any";
    const defaultValue = schema.default !== undefined ? `=${JSON.stringify(schema.default)}` : "";
    return `${key}${requirement} ${type}${defaultValue}`;
  }).join(", ");
}
