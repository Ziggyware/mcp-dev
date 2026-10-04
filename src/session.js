import fs from "node:fs";
import { getServer, listServers } from "./config.js";
import {
  callToolResilient,
  closeAllClients,
  disconnectServer,
  getOrConnectServer,
  listConnected,
  listTools,
  onToolsChanged,
  withCancellation,
  withTimeout,
} from "./mcpClient.js";
import { CANCELLED, promptForArgs, runAgentTurn } from "./suggest.js";
import { ResultBuffer } from "./resultBuffer.js";
import { mainPalette, BUILTIN_COMMAND_DESCRIPTIONS, formatParamHint } from "./palette.js";
import { compressIfNeeded } from "./history.js";
import { routeChat } from "./router.js";
import { style } from "./colors.js";
import { confirm, textInput, wordSearch } from "./prompts.js";
import { renderResult } from "./render.js";
import { formatTools } from "./toolDisplay.js";
import { cacheTools, getCachedTools, invalidateToolCache } from "./toolCache.js";
import { isPromptExit } from "./runtime.js";
import { isInteractive } from "./terminal.js";

const TOOL_TIMEOUT_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 8_000;

function sortedNames(servers) {
  return Object.keys(servers).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

async function chooseServer(names, message, { connected = null } = {}) {
  if (!names.length) return null;
  return wordSearch({
    message,
    source: async (input) => {
      const needle = String(input ?? "").toLowerCase();
      return names
        .filter((name) => !needle || name.toLowerCase().includes(needle))
        .map((name) => ({
          value: name,
          name: style.serverName(name),
          short: name,
          description: connected?.has(name) ? style.success("connected") : "registered",
        }));
    },
  });
}

async function chooseTool(server, tools, message = `/${server}/`) {
  if (!tools.length) return null;
  return wordSearch({
    message,
    pageSize: 8,
    source: async (input) => {
      const needle = String(input ?? "").toLowerCase();
      return tools
        .filter((tool) => !needle || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(needle))
        .map((tool) => ({
          value: tool.name,
          name: style.toolName(tool.name),
          short: tool.name,
          description: [tool.description ?? "", formatParamHint(tool.inputSchema) && style.muted(formatParamHint(tool.inputSchema))]
            .filter(Boolean)
            .join("  "),
        }));
    },
  });
}

function sessionHelp() {
  const lines = [
    style.heading("Session commands"),
    "",
    ...Object.entries(BUILTIN_COMMAND_DESCRIPTIONS).map(([name, description]) => `  ${style.toolName(`/${name}`)}  ${style.muted(description)}`),
    "",
    style.heading("Input"),
    `  ${style.toolName("plain text")}      ask the assistant`,
    `  ${style.toolName("/server/")}        browse a server's tools (lazy-connects)`,
    `  ${style.toolName("/server/tool")}    open a tool directly`,
    `  ${style.toolName("//message")}       send a message that starts with /`,
    "",
    style.heading("Keys"),
    `  ${style.toolName("Ctrl+Backspace")} / ${style.toolName("Ctrl+W")}  delete the previous word`,
    `  ${style.toolName("↑ / ↓")}                     move through matches`,
    `  ${style.toolName("Ctrl+C")}                    cancel the current prompt or tool request`,
    "",
    style.muted("Cached results can be reused as !7.field, !7[0], !7[\"key.with.dots\"], or !!. Use \\! for a literal exclamation mark."),
  ];
  console.log(lines.join("\n"));
}

async function confirmToolCall(server, tool, args, { message = "Proceed?" } = {}) {
  console.log(`\n${style.heading("About to call")} ${style.serverName(server)}/${style.toolName(tool)}`);
  console.log(style.muted(JSON.stringify(args, null, 2)));
  return confirm({ message, default: true });
}

async function invokeTool({ server, tool, args, registered, resultBuffer, json = false }) {
  const entry = registered[server] ?? getServer(server);
  if (!entry) throw new Error(`No server named "${server}".`);
  const result = await withCancellation(
    (signal) => callToolResilient(server, entry, tool, args, {
      signal,
      timeout: TOOL_TIMEOUT_MS,
      maxTotalTimeout: TOOL_TIMEOUT_MS,
    }),
    { timeoutMs: TOOL_TIMEOUT_MS, timeoutMessage: `Tool call ${server}/${tool}` }
  )();
  const index = resultBuffer.push({ server, tool, args, mcpResult: result });
  renderResult(result, { json });
  console.log(style.muted(`[cached as #${index} — reuse with !${index} or !!]`));
  return result;
}

async function refreshServer(server, registered, toolCache, cacheOrigin, subscriptions, { quiet = false } = {}) {
  const entry = registered[server] ?? getServer(server);
  if (!entry) throw new Error(`No server named "${server}".`);
  const client = await getOrConnectServer(server, entry, { timeoutMs: DISCOVERY_TIMEOUT_MS });
  const tools = await withTimeout(
    listTools(client, { timeout: DISCOVERY_TIMEOUT_MS, maxTotalTimeout: DISCOVERY_TIMEOUT_MS }),
    DISCOVERY_TIMEOUT_MS,
    `Listing tools for "${server}" timed out after ${DISCOVERY_TIMEOUT_MS}ms`
  );
  toolCache.set(server, tools);
  cacheOrigin.set(server, "live");
  cacheTools(server, entry, tools);

  if (!subscriptions.has(server)) {
    subscriptions.set(server, onToolsChanged(client, () => {
      toolCache.delete(server);
      cacheOrigin.delete(server);
      invalidateToolCache(server);
    }));
  }
  if (!quiet) console.log(style.success(`Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"} from "${server}".`));
  return tools;
}

async function ensureLiveTools(server, registered, toolCache, cacheOrigin, subscriptions) {
  if (toolCache.has(server) && cacheOrigin.get(server) === "live") return toolCache.get(server);
  return refreshServer(server, registered, toolCache, cacheOrigin, subscriptions, { quiet: true });
}

async function handleChat(text, context) {
  const { messages, toolCache, apiKey, registered, resultBuffer } = context;
  if (!apiKey) {
    console.log(style.error("Set ANTHROPIC_API_KEY to use chat. You can still browse and call tools directly."));
    return;
  }
  if (!text.trim()) return;

  messages.push({ role: "user", content: text });
  const { messages: compressed, error: compressionError } = await compressIfNeeded(messages, routeChat);
  if (compressionError) console.log(style.warning(`History compression skipped: ${compressionError.message}`));
  messages.length = 0;
  messages.push(...compressed);

  const tools = [...toolCache.entries()]
    .flatMap(([server, serverTools]) => serverTools.map((tool) => ({ ...tool, __server: server })))
    .sort((a, b) => a.__server.localeCompare(b.__server) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  const result = await runAgentTurn({
    messages,
    tools,
    apiKey,
    userQuery: null,
    confirmTool: (server, tool, args) => confirmToolCall(server, tool, args, { message: "Allow model-requested call?" }),
    executeTool: (server, tool, args, { signal } = {}) => callToolResilient(server, registered[server] ?? getServer(server), tool, args, {
      signal,
      timeout: TOOL_TIMEOUT_MS,
      maxTotalTimeout: TOOL_TIMEOUT_MS,
    }),
    onToolResult: async ({ server, tool, args, result: mcpResult }) => {
      const index = resultBuffer.push({ server, tool, args, mcpResult });
      console.log(style.muted(`[model result cached as #${index}]`));
    },
  });
  if (result.text.startsWith("[stopped after")) console.log(style.warning(result.text));
}

async function dispatchBuiltin(command, context) {
  const { toolCache, cacheOrigin, subscriptions, messages, apiKey, resultBuffer } = context;
  const registered = listServers();
  const names = sortedNames(registered);

  switch (command) {
    case "servers": {
      if (!names.length) {
        console.log(style.muted("No servers registered. Run `mcp-dev register <name>` first."));
        return;
      }
      const connected = new Set(listConnected());
      for (const name of names) {
        const origin = cacheOrigin.get(name);
        const state = connected.has(name) ? style.success("connected") : origin === "cached" ? style.muted("cached") : style.muted("idle");
        console.log(`${style.serverName(name)}  ${state}${registered[name].description ? style.muted(` — ${registered[name].description}`) : ""}`);
      }
      return;
    }
    case "connect": {
      const name = await chooseServer(names, "Connect to:", { connected: new Set(listConnected()) });
      if (!name) return;
      await refreshServer(name, registered, toolCache, cacheOrigin, subscriptions);
      return;
    }
    case "disconnect": {
      const connectedNames = listConnected();
      if (!connectedNames.length) {
        console.log(style.warning("No server connections are open."));
        return;
      }
      const name = await chooseServer(connectedNames, "Disconnect:", { connected: new Set(connectedNames) });
      if (!name) return;
      const closed = await disconnectServer(name);
      subscriptions.get(name)?.();
      subscriptions.delete(name);
      if (toolCache.has(name)) cacheOrigin.set(name, "cached");
      if (closed) console.log(style.success(`Disconnected "${name}".`));
      return;
    }
    case "tools": {
      const name = await chooseServer(names, "Tools for:", { connected: new Set(listConnected()) });
      if (!name) return;
      const tools = await refreshServer(name, registered, toolCache, cacheOrigin, subscriptions, { quiet: true });
      console.log(formatTools(tools));
      return;
    }
    case "refresh": {
      const name = await chooseServer(names, "Refresh tools for:", { connected: new Set(listConnected()) });
      if (!name) return;
      await refreshServer(name, registered, toolCache, cacheOrigin, subscriptions);
      return;
    }
    case "call": {
      const server = await chooseServer(names, "Server:", { connected: new Set(listConnected()) });
      if (!server) return;
      const tools = await ensureLiveTools(server, registered, toolCache, cacheOrigin, subscriptions);
      if (!tools.length) {
        console.log(style.warning(`"${server}" reports no tools.`));
        return;
      }
      const toolName = await chooseTool(server, tools, "Tool:");
      if (!toolName) return;
      const tool = tools.find((item) => item.name === toolName);
      const args = await promptForArgs(tool.inputSchema, resultBuffer);
      if (args === CANCELLED) {
        console.log(style.warning("Cancelled."));
        return;
      }
      if (!(await confirmToolCall(server, toolName, args))) {
        console.log(style.muted("Cancelled."));
        return;
      }
      await invokeTool({ server, tool: toolName, args, registered, resultBuffer });
      return;
    }
    case "results": {
      const entries = resultBuffer.list();
      if (!entries.length) {
        console.log(style.muted("No cached results yet."));
        return;
      }
      for (const entry of entries) {
        const preview = entry.text.replace(/\n/g, " ");
        console.log(`${style.bold(`#${entry.index}`)} ${style.serverName(entry.server)}/${style.toolName(entry.tool)} ${style.muted(preview.length > 80 ? `${preview.slice(0, 79)}…` : preview)}`);
      }
      return;
    }
    case "save": {
      const entries = resultBuffer.list();
      if (!entries.length) {
        console.log(style.warning("No cached results to save."));
        return;
      }
      const indexInput = await textInput({
        message: "Result # to save:",
        validate: (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? true : "Enter a positive result number.",
      });
      const entry = resultBuffer.get(Number(indexInput));
      if (!entry) {
        console.log(style.error(`No cached result #${indexInput}.`));
        return;
      }
      const target = await textInput({ message: "Save to path:", validate: (value) => value.trim() ? true : "A path is required." });
      if (fs.existsSync(target) && !(await confirm({ message: `"${target}" already exists. Overwrite?`, default: false }))) {
        console.log(style.muted("Cancelled."));
        return;
      }
      fs.writeFileSync(target, entry.text);
      console.log(style.success(`Saved result #${entry.index} to ${target}.`));
      return;
    }
    case "ask": {
      if (!apiKey) {
        console.log(style.error("Set ANTHROPIC_API_KEY to use /ask."));
        return;
      }
      const query = await textInput({ message: "Ask:", validate: (value) => value.trim() ? true : "Ask a question or press Ctrl+C to cancel." });
      await handleChat(query, { ...context, registered });
      return;
    }
    case "history":
      console.log(JSON.stringify(messages, null, 2));
      return;
    case "clear":
      messages.length = 0;
      console.log(style.success("Conversation history cleared. Connections and cached results remain."));
      return;
    case "help":
      sessionHelp();
      return;
    case "exit":
    case "quit":
      return { exit: true };
    default:
      return;
  }
}

function hydrateCachedTools(registered, toolCache, cacheOrigin) {
  for (const [name, entry] of Object.entries(registered)) {
    const cached = getCachedTools(name, entry, { allowStale: true });
    if (cached) {
      toolCache.set(name, cached.tools);
      cacheOrigin.set(name, "cached");
    }
  }
}

async function warmServers(registered, context) {
  const names = sortedNames(registered);
  const outcomes = await Promise.allSettled(names.map((name) =>
    refreshServer(name, registered, context.toolCache, context.cacheOrigin, context.subscriptions, { quiet: true })
  ));
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") console.log(style.success(`✓ ${names[index]} (${outcome.value.length} tools)`));
    else console.log(style.warning(`✗ ${names[index]} — ${outcome.reason.message}`));
  }
}

export async function startSession({ warm = false } = {}) {
  if (!isInteractive()) throw new Error("`mcp-dev session` requires an interactive terminal.");
  const registered = listServers();
  const context = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    messages: [],
    toolCache: new Map(),
    cacheOrigin: new Map(),
    subscriptions: new Map(),
    resultBuffer: new ResultBuffer(),
  };
  hydrateCachedTools(registered, context.toolCache, context.cacheOrigin);

  console.log(style.heading("mcp-dev session"));
  console.log(style.muted(`Ready immediately — ${context.toolCache.size} cached server${context.toolCache.size === 1 ? "" : "s"}. Type /help for commands and shortcuts.`));

  try {
    if (warm) await warmServers(registered, context);
    while (true) {
      const servers = listServers();
      // Clear metadata for registrations removed by another terminal while the
      // session is open; connections can still be explicitly disconnected.
      for (const name of context.toolCache.keys()) {
        if (!(name in servers)) {
          context.toolCache.delete(name);
          context.cacheOrigin.delete(name);
        }
      }

      let selection;
      try {
        selection = await mainPalette(sortedNames(servers), context.toolCache);
      } catch (error) {
        if (isPromptExit(error)) {
          console.log(style.muted("Cancelled."));
          continue;
        }
        throw error;
      }
      if (!selection || selection.kind === "noop") continue;

      if (selection.kind === "chat") {
        try {
          await handleChat(selection.raw, { ...context, registered: servers });
        } catch (error) {
          console.log(isPromptExit(error) ? style.muted("Cancelled.") : style.error(error.message));
        }
        continue;
      }
      if (selection.kind === "builtin") {
        try {
          const outcome = await dispatchBuiltin(selection.raw, { ...context });
          if (outcome?.exit) break;
        } catch (error) {
          console.log(isPromptExit(error) ? style.muted("Cancelled.") : style.error(error.message));
        }
        continue;
      }
      if (selection.kind === "server-select") {
        try {
          const tools = await ensureLiveTools(selection.server, servers, context.toolCache, context.cacheOrigin, context.subscriptions);
          if (!tools.length) {
            console.log(style.warning(`"${selection.server}" reports no tools.`));
            continue;
          }
          const toolName = await chooseTool(selection.server, tools, `/${selection.server}/`);
          if (!toolName) continue;
          selection = {
            kind: "tool-call",
            server: selection.server,
            tool: toolName,
            schema: tools.find((tool) => tool.name === toolName)?.inputSchema,
          };
        } catch (error) {
          console.log(style.error(error.message));
          continue;
        }
      }
      if (selection.kind === "tool-call") {
        try {
          const freshTools = await ensureLiveTools(selection.server, servers, context.toolCache, context.cacheOrigin, context.subscriptions);
          const freshTool = freshTools.find((tool) => tool.name === selection.tool);
          if (!freshTool) {
            console.log(style.warning(`Tool "${selection.tool}" is no longer available on "${selection.server}". The live list was refreshed.`));
            continue;
          }
          const args = await promptForArgs(freshTool.inputSchema, context.resultBuffer);
          if (args === CANCELLED) {
            console.log(style.warning("Cancelled."));
            continue;
          }
          if (!(await confirmToolCall(selection.server, selection.tool, args))) {
            console.log(style.muted("Cancelled."));
            continue;
          }
          await invokeTool({ server: selection.server, tool: selection.tool, args, registered: servers, resultBuffer: context.resultBuffer });
        } catch (error) {
          if (isPromptExit(error)) console.log(style.muted("Cancelled."));
          else console.log(style.error(error.message));
        }
      }
    }
  } finally {
    for (const unsubscribe of context.subscriptions.values()) unsubscribe();
    await closeAllClients();
  }

  console.log(style.success("Closed all connections."));
}
