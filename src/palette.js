// src/palette.js — replaces askLine's role for the main command line entirely

import { search } from "@inquirer/prompts";
import { style } from "./colors.js";

// "results" and "save" added here (only change from baseline) so the new
// result-buffer commands show up in the "/" palette like every other
// builtin, instead of only being reachable if the user already knows the
// exact command name.
const BUILTIN_COMMANDS = [
  "connect", "disconnect", "servers", "tools", "call", "ask",
  "results", "save", "history", "clear", "help", "exit",
];
export function formatParamHint(inputSchema) {
  if (!inputSchema?.properties) return "";
  const required = new Set(inputSchema.required ?? []);
  const parts = Object.entries(inputSchema.properties).map(([k, s]) => {
    const req = required.has(k) ? "*" : "";
    const type = s.type ?? "any";
    const def = s.default !== undefined ? `=${s.default}` : "";
    return `${k}${req} ${type}${def}`;
  });
  return parts.join(", ");
}

// toolsByServer: Map<serverName, Array<tool>> from toolCache (object-shaped,
// per the earlier fix to session.js's tool discovery). registeredServerNames:
// every registered server, connected or not.
//
// source is invoked on every keystroke (including the initial empty-string
// call on prompt entry), which is what makes the list appear the instant "/"
// is pressed rather than requiring Enter first.
//
// No "/" in the typed text -> builtins + server-select entries, filtered by
// whatever's been typed. A "/" present -> drill into that server's tools,
// filtered by whatever follows the "/".
export async function mainPalette(registeredServerNames, toolsByServer) {
  const builtinEntries = BUILTIN_COMMANDS.map((c) => ({
    value: { kind: "builtin", raw: c },
    name: c,
  }));
  const serverEntries = registeredServerNames.map((s) => ({
    value: { kind: "server-select", raw: `${s}/` },
    name: `${style.serverName(s)}/`,
    description: "→ browse tools",
  }));

  const selection = await search({
    message: ">",
    loop: true,
    source: async (input) => {
      const text = input ?? "";
      const slash = text.indexOf("/");


      if (slash !== -1) {
        const serverPart = text.slice(0, slash);
        const toolPart = text.slice(slash + 1).toLowerCase();

        if (serverPart === "") {
          return registeredServerNames
            .filter((s) => toolsByServer.has(s))
            .map((s) => ({
              value: { kind: "server-select", raw: `${s}/` },
              name: `${style.serverName(s)}/`,
              description: "→ browse tools",
            }));
        }

        if (!toolsByServer.has(serverPart)) {
          // kind: "noop" -- selecting this entry must not be treated as a
          // chat message. session.js's loop checks for "noop" and just
          // continues.
          return [{
            value: { kind: "noop" },
            name: style.warning(`"${serverPart}" not connected or not yet discovered — check with /servers`),
          }];
        }

        const tools = toolsByServer.get(serverPart);
        if (tools.length === 0) {
          return [{
            value: { kind: "noop" },
            name: style.muted(`"${serverPart}" is connected but reports zero tools`),
          }];
        }

        return tools
          .filter((t) => !toolPart || t.name.toLowerCase().includes(toolPart))
          .map((t) => ({
            value: { kind: "tool-call", server: serverPart, tool: t.name, schema: t.inputSchema },
            name: `${style.serverName(serverPart)}/${style.toolName(t.name)}`,
            description: [
              t.description ?? "",
              formatParamHint(t.inputSchema) && style.muted(formatParamHint(t.inputSchema)),
            ].filter(Boolean).join("  "),
          }));
      }

      // No "/": builtins + server-select entries, filtered by typed text.
      const needle = text.toLowerCase();
      return [...builtinEntries, ...serverEntries].filter((e) =>
        !needle || e.name.toLowerCase().includes(needle)
      );
    },
  });

  return selection;
}

// Level 1: built-ins + server names, shown immediately -- source fires on
// prompt entry with input="" before any keystroke, which is what makes this
// appear "on pressing /" rather than "on pressing / then Enter". Selecting a
// server name (not a built-in) routes to level 2 rather than executing.
async function paletteLevel1(registeredServerNames) {
  const entries = [
    ...BUILTIN_COMMANDS.map((c) => ({ value: { kind: "builtin", name: c }, name: c })),
    ...registeredServerNames.map((s) => ({
      value: { kind: "server", name: s },
      name: `${style.serverName(s)}/`,
      description: "select to browse this server's tools",
    })),
  ];
  return search({
    message: "/",
    source: async (input) => {
      if (!input) return entries;
      const needle = input.toLowerCase();
      return entries.filter((e) => e.name.toLowerCase().includes(needle));
    },
  });
}

// Level 2: one server's tools, with param hints inline. Only reached after
// explicitly selecting a server at level 1 -- this is what makes "/ then
// select an mcp service" produce the MCP command list, distinct from level 1.
async function paletteLevel2(serverName, tools) {
  const entries = tools.map((t) => ({
    value: { server: serverName, tool: t.name, schema: t.inputSchema },
    name: `${style.toolName(t.name)}`,
    description: [t.description ?? "", formatParamHint(t.inputSchema) && style.muted(formatParamHint(t.inputSchema))]
      .filter(Boolean).join("  "),
  }));
  if (entries.length === 0) {
    console.log(style.warning(`No tools discovered on "${serverName}" yet.`));
    return null;
  }
  return search({
    message: `/${serverName}/`,
    source: async (input) => {
      if (!input) return entries;
      const needle = input.toLowerCase();
      return entries.filter((e) => e.value.tool.toLowerCase().includes(needle));
    },
  });
}

async function showCommandPalette(toolsByServer) {
  const entries = [];
  for (const [serverName, tools] of toolsByServer) {
    for (const tool of tools) {
      entries.push({
        value: { server: serverName, tool: tool.name, schema: tool.inputSchema },
        name: `${style.serverName(serverName)}/${style.toolName(tool.name)}`,
        description: [
          tool.description ?? "",
          formatParamHint(tool.inputSchema) && style.muted(formatParamHint(tool.inputSchema)),
        ].filter(Boolean).join("  "),
      });
    }
  }

  if (entries.length === 0) {
    console.log(style.warning("No tools discovered yet. Run `tools <server>` first, or `/` will auto-discover on first use (see session.js)."));
    return null;
  }

  const selected = await search({
    message: "/",
    source: async (input) => {
      if (!input) return entries;
      const needle = input.toLowerCase();
      return entries.filter((e) =>
        `${e.value.server}/${e.value.tool}`.toLowerCase().includes(needle) ||
        (e.value.schema?.description ?? "").toLowerCase().includes(needle)
      );
    },
  });

  return selected; // { server, tool, schema }
}
export { paletteLevel1, paletteLevel2, showCommandPalette, BUILTIN_COMMANDS };