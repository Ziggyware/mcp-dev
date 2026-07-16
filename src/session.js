// src/session.js — FULL FILE, current state, all prior fragments reconciled
import inquirer from "inquirer";
import { getServer, listServers } from "./config.js";
import { getOrConnectServer, disconnectServer, listConnected, listTools, callTool, closeAllClients } from "./mcpClient.js";
import { promptForArgs, runAgentTurn, CANCELLED } from "./suggest.js";
import { mainPalette, BUILTIN_COMMANDS, formatParamHint } from "./palette.js";
import { compressIfNeeded } from "./history.js";
import { routeChat } from "./router.js";
import { colors, style } from "./colors.js";
import { search } from "@inquirer/prompts";

function printResult(result) {
  const text = (result.content ?? [])
    .map((b) => (b.type === "text" ? b.text : JSON.stringify(b, null, 2)))
    .join("\n");
  console.log(text || JSON.stringify(result, null, 2));
}

async function handleChat(text, toolCache, messages, apiKey) {
  messages.push({ role: "user", content: text });
  const compressed = await compressIfNeeded(messages, routeChat);
  messages.length = 0;
  messages.push(...compressed);

  const flatTools = [...toolCache.entries()].flatMap(([serverName, tools]) =>
    tools.map((t) => ({ ...t, __server: serverName }))
  );

  const result = await runAgentTurn({
    messages,
    tools: flatTools,
    apiKey,
    userQuery: null, // pre-pushed above; requires the runAgentTurn edit flagged last turn
    confirmTool: async (serverName, toolName, args) => {
      console.log(`\n${style.heading("Model wants to call")} ${style.toolName(toolName)} ${style.muted("on")} ${style.serverName(serverName)}:`);
      console.log(style.muted(JSON.stringify(args, null, 2)));
      const { ok } = await inquirer.prompt([{ type: "confirm", name: "ok", message: "Allow?", default: true }]);
      return ok;
    },
    executeTool: async (serverName, toolName, args) => {
      const client = await getOrConnectServer(serverName, getServer(serverName));
      return callTool(client, toolName, args);
    },
  });

  console.log(`\n${result.text}`);
}

async function dispatchBuiltin(command, toolCache, messages, apiKey) {
  const registered = listServers();

  switch (command) {
    case "servers": {
      const connected = new Set(listConnected());
      for (const name of Object.keys(registered)) {
        console.log(`${style.serverName(name)}${connected.has(name) ? " " + style.success("[connected]") : ""}`);
      }
      return;
    }
    case "connect": {
      const { name } = await inquirer.prompt([{ type: "list", name: "name", message: "Server to connect:", choices: Object.keys(registered) }]);
      const entry = registered[name];
      if (!entry) { console.error(style.error(`No server named "${name}".`)); return; }
      const client = await getOrConnectServer(name, entry);
      toolCache.set(name, await listTools(client));
      console.log(style.success(`Connected to "${name}".`));
      return;
    }
    case "disconnect": {
      const connectedNames = listConnected();
      if (connectedNames.length === 0) { console.log(style.warning("Nothing connected.")); return; }
      const { name } = await inquirer.prompt([{ type: "list", name: "name", message: "Server to disconnect:", choices: connectedNames }]);
      const closed = await disconnectServer(name);
      console.log(closed ? style.success(`Disconnected "${name}".`) : style.warning(`"${name}" was not connected.`));
      toolCache.delete(name);
      return;
    }
    case "tools": {
      const { name } = await inquirer.prompt([{ type: "list", name: "name", message: "Server:", choices: Object.keys(registered) }]);
      const entry = registered[name];
      const client = await getOrConnectServer(name, entry);
      const tools = await listTools(client);
      toolCache.set(name, tools);
      for (const t of tools) {
        console.log(`\n${style.toolName(t.name)}${t.description ? " " + style.muted("- " + t.description) : ""}`);
        const props = t.inputSchema?.properties ?? {};
        const required = new Set(t.inputSchema?.required ?? []);
        for (const [k, s] of Object.entries(props)) {
          const marker = required.has(k) ? style.required("*") : "";
          console.log(`  - ${colors.cyan(k)}${marker}: ${style.muted(s.type ?? "any")}${s.description ? style.muted(" - " + s.description) : ""}`);
        }
      }
      return;
    }
    case "call":
      console.log(style.muted("Use the server/tool palette entries directly instead of `call`.")); // still-unresolved redundancy, named two turns ago
      return;
    case "ask": {
      if (!apiKey) { console.error(style.error("No LLM credentials configured.")); return; }
      const { query } = await inquirer.prompt([{ type: "input", name: "query", message: "Ask:" }]);
      await handleChat(query, toolCache, messages, apiKey);
      return;
    }
    case "history":
      console.log(style.muted(JSON.stringify(messages, null, 2)));
      return;
    case "clear":
      messages.length = 0;
      console.log(style.success("Conversation history cleared. Connections remain open."));
      return;
    case "help":
      console.log(style.heading("Commands"), style.muted(BUILTIN_COMMANDS.join(", ")));
      return;
    case "exit":
    case "quit":
      await closeAllClients();
      console.log(style.success("Closed all connections."));
      process.exit(0);
  }
}

export async function startSession() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const messages = [];
  const toolCache = new Map();

  console.log(style.heading("mcp-dev session"));
  console.log(style.muted("Press / for commands. Type freely to chat."));
  // src/session.js — startSession's main loop, wrapping the palette calls
  // in try/catch to handle search()'s actual throw-on-cancel behavior,
  // confirmed by your transcript rather than assumed.

  while (true) {
    const registered = listServers();
    const registeredNames = Object.keys(registered);

    for (const [name, entry] of Object.entries(registered)) {
      if (toolCache.has(name)) continue;
      try {
        const client = await getOrConnectServer(name, entry);
        toolCache.set(name, await listTools(client));
      } catch { /* server down */ }
    }

    let selection;
    try {
      selection = await mainPalette(registeredNames, toolCache);
    } catch (err) {
      if (err?.name === "ExitPromptError") continue; // Ctrl+C at top level: just re-render
      throw err;
    }
    if (selection === undefined) continue;

    if (selection.kind === "server-select") {
      const serverName = selection.raw.replace(/\/$/, "");
      const tools = toolCache.get(serverName) ?? [];
      if (tools.length === 0) {
        console.log(style.warning(`No tools discovered on "${serverName}" yet.`));
        continue;
      }
      let toolSelection;
      try {
        toolSelection = await search({
          message: `/${serverName}/`,
          source: async (input) => {
            const needle = (input ?? "").toLowerCase();
            return tools
              .filter((t) => !needle || t.name.toLowerCase().includes(needle))
              .map((t) => ({
                value: { kind: "tool-call", server: serverName, tool: t.name, schema: t.inputSchema },
                name: style.toolName(t.name),
                description: [t.description ?? "", formatParamHint(t.inputSchema) && style.muted(formatParamHint(t.inputSchema))]
                  .filter(Boolean).join("  "),
              }));
          },
        });
      } catch (err) {
        if (err?.name === "ExitPromptError") continue; // Ctrl+C inside server drill: back out to top-level, NOT process exit
        throw err;
      }
      selection = toolSelection;
    }

    if (selection.kind === "chat") {
      await handleChat(selection.raw, toolCache, messages, apiKey);
      continue;
    }
    if (selection.kind === "builtin") {
      await dispatchBuiltin(selection.raw, toolCache, messages, apiKey);
      continue;
    }
    if (selection.kind === "tool-call") {
      const { server, tool, schema } = selection;
      let args;
      try {
        args = await promptForArgs(schema);
      } catch (err) {
        if (err?.name === "ExitPromptError") { console.log(style.warning("Cancelled.")); continue; }
        throw err;
      }
      if (args === CANCELLED) {
        console.log(style.warning("Cancelled — missing required field."));
        continue;
      }
      const client = await getOrConnectServer(server, registered[server]);
      const result = await callTool(client, tool, args);
      printResult(result);
      continue;
    }
    if (selection.kind === "noop") continue;
  }
}