import { style } from "./colors.js";
import { wordSearch } from "./prompts.js";

export const BUILTIN_COMMANDS = [
  "connect", "disconnect", "servers", "tools", "call", "ask", "results",
  "save", "history", "clear", "refresh", "help", "exit", "quit",
];

export const BUILTIN_COMMAND_DESCRIPTIONS = {
  connect: "connect a registered server",
  disconnect: "close one active server connection",
  servers: "list servers and connection state",
  tools: "inspect a server's current tools",
  call: "choose and call one tool",
  ask: "ask the model to use connected tools",
  results: "list cached tool outputs",
  save: "write one cached result to a file",
  history: "show conversation history",
  clear: "clear conversation history",
  refresh: "reload a server's tool list",
  help: "show interactive help and keyboard shortcuts",
  exit: "close connections and leave session",
  quit: "close connections and leave session",
};

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

function builtinEntries() {
  return BUILTIN_COMMANDS.map((command) => ({
    value: { kind: "builtin", raw: command },
    name: `/${command}`,
    short: `/${command}`,
    description: BUILTIN_COMMAND_DESCRIPTIONS[command],
    searchText: command,
  }));
}

function serverEntries(registeredServerNames) {
  return registeredServerNames.map((server) => ({
    value: { kind: "server-select", server, filter: "" },
    name: `/${style.serverName(server)}/`,
    short: `/${server}/`,
    description: "browse tools (connects only when selected)",
    searchText: server,
  }));
}

function toolEntries(server, tools, filter = "") {
  const needle = filter.toLowerCase();
  return tools
    .filter((tool) => !needle || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(needle))
    .map((tool) => ({
      value: { kind: "tool-call", server, tool: tool.name, schema: tool.inputSchema },
      name: `${style.serverName(server)}/${style.toolName(tool.name)}`,
      short: `${server}/${tool.name}`,
      description: [tool.description ?? "", formatParamHint(tool.inputSchema) && style.muted(formatParamHint(tool.inputSchema))]
        .filter(Boolean)
        .join("  "),
      searchText: `${server}/${tool.name} ${tool.description ?? ""}`,
    }));
}

function filterEntries(entries, input) {
  const needle = String(input ?? "").toLowerCase();
  return entries.filter((entry) => !needle || entry.searchText.toLowerCase().includes(needle));
}

function routeEntry(text, registeredServerNames, toolsByServer) {
  const candidate = text.startsWith("/") ? text.slice(1) : text;
  const slash = candidate.indexOf("/");
  if (slash === -1) return null;
  const server = candidate.slice(0, slash);
  const filter = candidate.slice(slash + 1);
  if (!registeredServerNames.includes(server)) return null;
  const tools = toolsByServer.get(server);
  if (!tools) {
    return [{
      value: { kind: "server-select", server, filter },
      name: `/${style.serverName(server)}/`,
      short: `/${server}/`,
      description: filter ? `connect and search tools for “${filter}”` : "connect and browse tools",
      searchText: server,
    }];
  }
  const entries = toolEntries(server, tools, filter);
  if (entries.length) return entries;
  return [{
    value: { kind: "server-select", server, filter },
    name: style.muted(`No cached match for ${server}/${filter} — refresh and search`),
    short: `/${server}/`,
    description: "connect and inspect the live tool list",
    searchText: server,
  }];
}

/**
 * Main session chooser:
 *   - plain text is a chat message;
 *   - /command opens a built-in command;
 *   - /server/tool (and the legacy server/tool spelling) opens a tool;
 *   - //text sends a chat message beginning with '/'.
 */
export async function mainPalette(registeredServerNames, toolsByServer) {
  const builtins = builtinEntries();
  const servers = serverEntries(registeredServerNames);

  return wordSearch({
    message: style.prompt(">"),
    pageSize: 8,
    source: async (input) => {
      const raw = String(input ?? "");
      const text = raw.trim();
      if (text.startsWith("//")) {
        return [{
          value: { kind: "chat", raw: text.slice(1) },
          name: `Ask: ${text.slice(1)}`,
          short: text.slice(1),
          description: "send a message beginning with /",
          searchText: text,
        }];
      }

      const routed = routeEntry(text, registeredServerNames, toolsByServer);
      if (routed) return routed;

      if (text.startsWith("/")) {
        const commandNeedle = text.slice(1);
        return filterEntries([...builtins, ...servers], commandNeedle);
      }

      if (text) {
        return [
          {
            value: { kind: "chat", raw: text },
            name: `${style.heading("Ask:")} ${text}`,
            short: text,
            description: "send this message to the session assistant",
            searchText: text,
          },
          ...filterEntries([...servers, ...builtins], text),
        ];
      }

      return [
        {
          value: { kind: "noop" },
          name: style.muted("Type a message to chat, / for commands, or /server/ for tools"),
          short: "",
          description: "Ctrl+Backspace deletes a word",
          searchText: "",
          disabled: true,
        },
        ...builtins,
        ...servers,
      ];
    },
  });
}

export async function paletteLevel1(registeredServerNames) {
  return wordSearch({
    message: "/",
    source: async (input) => filterEntries([...builtinEntries(), ...serverEntries(registeredServerNames)], input),
  });
}

export async function paletteLevel2(serverName, tools) {
  return wordSearch({
    message: `/${serverName}/`,
    source: async (input) => toolEntries(serverName, tools, input ?? ""),
  });
}

export async function showCommandPalette(toolsByServer) {
  const entries = [];
  for (const [server, tools] of toolsByServer) entries.push(...toolEntries(server, tools));
  return wordSearch({
    message: "/",
    source: async (input) => filterEntries(entries, input),
  });
}
