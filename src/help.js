import { terminalColumns } from "./terminal.js";

export const VERSION = "0.2.0";

export const COMMAND_HELP = {
  register: {
    group: "Setup",
    usage: "mcp-dev register <name> [options]",
    summary: "Add a stdio or Streamable HTTP MCP server.",
    details: "With no transport flags, registration is guided interactively. Arguments are parsed like a shell command line, without executing a shell.",
    options: [
      "--url <url>                 Register a Streamable HTTP endpoint",
      "--command <command>         Register a stdio command",
      "--arg <value>               Add one stdio argument (repeatable)",
      "--args <text>               Parse a quoted argument string",
      "--cwd <path>                Working directory for a stdio server",
      "--root <path>               MCP filesystem root to advertise",
      "--env <KEY=VALUE>           Extra env var (repeatable)",
      "--header <KEY=VALUE>        HTTP header (repeatable; supports ${ENV})",
      "--description <text>        Short label shown in listings",
      "--inherit-env               Pass the full shell environment",
      "--allow-sampling            Permit server-initiated model sampling",
      "--force                     Replace an existing registration",
    ],
    examples: [
      "mcp-dev register files --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg ~/work",
      "mcp-dev register docs --url https://example.test/mcp --header 'Authorization=${DOCS_AUTH}'",
    ],
  },
  unregister: {
    group: "Setup",
    usage: "mcp-dev unregister <name> [--force]",
    summary: "Remove a server registration.",
    details: "Interactive terminals ask before deleting. Use --force only in trusted automation.",
    options: ["--force                     Do not ask for confirmation"],
    examples: ["mcp-dev unregister old-files"],
  },
  list: {
    group: "Discover",
    usage: "mcp-dev list [--plain | --json]",
    summary: "List registered servers without exposing sensitive URL query values.",
    options: [
      "--plain                     One server name per line",
      "--json                      Machine-readable registration summary",
    ],
    examples: ["mcp-dev list", "mcp-dev list --json | jq '.[].name'"],
  },
  tools: {
    group: "Discover",
    usage: "mcp-dev tools <server> [options]",
    summary: "Inspect a server's tools and input schemas.",
    options: [
      "--json                      Emit raw MCP tool definitions",
      "--plain                     Emit only tool names (for scripts/completion)",
      "--cached                    Read the local metadata cache; do not connect",
      "--timeout <ms>              Bound connection and listing time (default: 8000)",
    ],
    examples: ["mcp-dev tools files", "mcp-dev tools files --plain"],
  },
  call: {
    group: "Run",
    usage: "mcp-dev call <server> <tool> [options]",
    summary: "Call one tool with schema-aware argument prompts and explicit approval.",
    details: "--args and --args-file avoid field prompts, but never bypass the approval prompt. Tool errors return a non-zero exit status.",
    options: [
      "--args <json>               Provide the complete arguments object",
      "--args-file <path>          Read the arguments object from a JSON file",
      "--json                      Print the raw MCP result",
      "--dry-run                   Show validated arguments without calling",
      "--no-pager                  Print long output directly",
      "--timeout <ms>              Bound the tool request (default: 30000)",
    ],
    examples: [
      "mcp-dev call files read_file",
      "mcp-dev call files read_file --args '{\"path\":\"README.md\"}' --dry-run",
    ],
  },
  ask: {
    group: "Run",
    usage: "mcp-dev ask <query...> [-s <server>]",
    summary: "Let a model plan a confirmed, multi-step MCP tool sequence.",
    details: "Requires ANTHROPIC_API_KEY. Every proposed tool invocation is shown and must be allowed individually.",
    options: ["-s, --server <name>        Restrict the model to one server"],
    examples: ["mcp-dev ask -s files 'find the largest JSON file'"],
  },
  session: {
    group: "Run",
    usage: "mcp-dev session [--warm]",
    summary: "Open a fast, persistent interactive workspace.",
    details: "Session startup is lazy: cached tool metadata is available immediately and servers connect only when selected. --warm refreshes every server first.",
    options: ["--warm                      Pre-connect and refresh every server"],
    examples: ["mcp-dev session", "mcp-dev session --warm"],
  },
  doctor: {
    group: "Maintenance",
    usage: "mcp-dev doctor [options]",
    summary: "Health-check registered servers without calling their tools.",
    options: [
      "-t, --timeout <ms>          Per-server connection/list timeout (default: 5000)",
      "-j, --concurrency <count>   Parallel checks (default: 4)",
      "--json                      Machine-readable health report",
    ],
    examples: ["mcp-dev doctor --concurrency 8", "mcp-dev doctor --json"],
  },
  completion: {
    group: "Maintenance",
    usage: "mcp-dev completion <bash|zsh|pwsh>",
    summary: "Generate dynamic shell completion, including cached tool names.",
    examples: ["mcp-dev completion zsh > " + '"${fpath[1]}/_mcp-dev"'],
  },
};

function wrap(text, indent = "", width = terminalColumns(), continuationIndent = indent) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return indent;
  const lineWidth = Math.max(30, width - indent.length);
  const lines = [];
  let line = indent;
  for (const word of words) {
    const next = line === indent ? `${indent}${word}` : `${line} ${word}`;
    if (next.length > lineWidth && line !== indent) {
      lines.push(line);
      line = `${continuationIndent}${word}`;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

function optionsBlock(options, width) {
  if (!options?.length) return [];
  return ["", "Options:", ...options.map((option) => wrap(option, "  ", width))];
}

function examplesBlock(examples, width) {
  if (!examples?.length) return [];
  return ["", "Examples:", ...examples.map((example) => wrap(`$ ${example}`, "  ", width, "    "))];
}

export function renderHelp(topic, { width = terminalColumns() } = {}) {
  const normalized = topic?.replace(/^\/+/, "").toLowerCase();
  const entry = normalized ? COMMAND_HELP[normalized] : null;

  if (normalized && !entry) {
    return [
      `Unknown help topic: ${topic}`,
      "",
      renderHelp(null, { width }),
    ].join("\n");
  }

  if (entry) {
    return [
      entry.usage,
      "",
      wrap(entry.summary, "", width),
      ...(entry.details ? ["", wrap(entry.details, "", width)] : []),
      ...optionsBlock(entry.options, width),
      ...examplesBlock(entry.examples, width),
      "",
      "Tip: Ctrl+Backspace (or Ctrl+W) deletes the previous word in text and search prompts.",
    ].join("\n");
  }

  const groups = new Map();
  for (const [name, command] of Object.entries(COMMAND_HELP)) {
    const list = groups.get(command.group) ?? [];
    list.push([name, command]);
    groups.set(command.group, list);
  }

  const lines = [
    "mcp-dev — a fast, approval-first MCP command line",
    "",
    "Usage:",
    "  mcp-dev <command> [options]",
    "  mcp-dev help [command]",
    "",
    "Start here:",
    "  mcp-dev register <name>     Add a server",
    "  mcp-dev tools <server>      See what it exposes",
    "  mcp-dev call <server> <tool> Run one approved tool call",
    "  mcp-dev session             Open the interactive workspace",
  ];

  for (const [group, commands] of groups) {
    lines.push("", `${group}:`);
    const longest = Math.max(...commands.map(([name]) => name.length));
    for (const [name, command] of commands) {
      lines.push(`  ${name.padEnd(longest)}  ${command.summary}`);
    }
  }

  lines.push(
    "",
    "Helpful shortcuts:",
    "  mcp-dev help <command>      Focused examples and options",
    "  Ctrl+Backspace / Ctrl+W     Delete the previous word in interactive text",
    "  Ctrl+C                      Cancel a prompt or an in-flight tool call",
    "",
    "Safety: mcp-dev always asks before executing a tool call. Use --dry-run to inspect a call without executing it.",
  );
  return lines.join("\n");
}

/** Return a static help/version response before heavy MCP dependencies load. */
export function fastHelpRequest(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => arg !== "--");
  if (args.includes("--version") || args.includes("-V")) return { type: "version" };

  if (args.length === 0) return { type: "help", topic: null };
  if (args[0] === "help") return { type: "help", topic: args[1] ?? null };
  if (args.includes("--help") || args.includes("-h")) {
    const topic = args.find((arg) => Object.hasOwn(COMMAND_HELP, arg));
    return { type: "help", topic: topic ?? null };
  }
  return null;
}
