// src/commands.js
//
// Canonical description of every in-session command. One source of truth means
// the palette, `/help`, the command table in the README, and the shell
// completion cannot drift apart.

export const SESSION_COMMANDS = [
  {
    name: "help",
    aliases: ["?", "h"],
    group: "Session",
    description: "show the guide: input modes, commands, keys, cached values",
    usage: "/help",
    keys: ["?"],
  },
  {
    name: "servers",
    group: "Servers",
    description: "list registered servers and their connection state",
    usage: "/servers",
  },
  {
    name: "connect",
    group: "Servers",
    description: "connect a registered server and load its tools",
    usage: "/connect [server]",
    examples: ["/connect", "/connect wordnet"],
  },
  {
    name: "disconnect",
    group: "Servers",
    description: "close one active server connection",
    usage: "/disconnect [server]",
  },
  {
    name: "tools",
    group: "Servers",
    description: "inspect a server's tools, parameters, and constraints",
    usage: "/tools [server]",
  },
  {
    name: "refresh",
    group: "Servers",
    description: "reload a server's tool list from the live process",
    usage: "/refresh [server]",
  },
  {
    name: "call",
    group: "Tools",
    description: "pick a server and tool, then fill the arguments as a form",
    usage: "/call [server] [tool]",
    examples: ["/call", "/call wordnet read"],
  },
  {
    name: "ask",
    group: "Tools",
    description: "ask the assistant; it proposes tool calls you can approve",
    usage: "/ask <question>",
    examples: ["/ask which files mention the cache?"],
    requiresApiKey: true,
  },
  {
    name: "results",
    group: "Cached results",
    description: "list cached tool outputs with ready-to-paste references",
    usage: "/results",
  },
  {
    name: "result",
    group: "Cached results",
    description: "display one cached result, or a path inside it",
    usage: "/result <n>[.path]",
    examples: ["/result 2", "/result 2.rows[0].name"],
  },
  {
    name: "save",
    group: "Cached results",
    description: "write a cached result (or a path inside it) to a file",
    usage: "/save <n>[.path] [file]",
    examples: ["/save 2 out.json"],
  },
  {
    name: "history",
    group: "Session",
    description: "show the conversation history",
    usage: "/history",
  },
  {
    name: "clear",
    group: "Session",
    description: "clear the screen and conversation history (connections and cache stay)",
    usage: "/clear",
  },
  {
    name: "cd",
    group: "Paths",
    description: "change the directory that path prompts start from",
    usage: "/cd [directory]",
    examples: ["/cd", "/cd ../server"],
  },
  {
    name: "pwd",
    group: "Paths",
    description: "print the current path-prompt directory",
    usage: "/pwd",
  },
  {
    name: "approvals",
    aliases: ["trust"],
    group: "Approvals",
    description: "show or clear the auto-approval grants for this session",
    usage: "/approvals [clear]",
    examples: ["/approvals", "/approvals clear"],
  },
  {
    name: "untrust",
    group: "Approvals",
    description: "revoke an approval grant (tool, server:<name>, or all)",
    usage: "/untrust [tool|server:<name>|all]",
  },
  {
    name: "color",
    group: "Display",
    description: "switch colours: auto, always, never, or basic",
    usage: "/color <auto|always|never|basic>",
  },
  {
    name: "mouse",
    group: "Display",
    description: "toggle mouse-wheel transcript scrolling (off restores text selection)",
    usage: "/mouse <on|off>",
  },
  {
    name: "keys",
    group: "Display",
    description: "show the keyboard reference",
    usage: "/keys",
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    group: "Session",
    description: "close every connection and leave the session",
    usage: "/exit",
  },
];

export const COMMANDS_BY_NAME = new Map();
for (const command of SESSION_COMMANDS) {
  COMMANDS_BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) COMMANDS_BY_NAME.set(alias, command);
}

export const BUILTIN_COMMANDS = SESSION_COMMANDS.map((command) => command.name);

export const BUILTIN_COMMAND_DESCRIPTIONS = Object.fromEntries(
  SESSION_COMMANDS.map((command) => [command.name, command.description])
);

export function findCommand(name) {
  return COMMANDS_BY_NAME.get(String(name ?? "").toLowerCase().replace(/^\/+/, "")) ?? null;
}

export function commandNames() {
  return SESSION_COMMANDS.map((command) => command.name);
}
