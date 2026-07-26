// src/session.js — FULL FILE, current state
import { ResultBuffer } from "./resultBuffer.js";
import inquirer from "inquirer";
import fs from "node:fs";
import { getServer, listServers } from "./config.js";
import {
  getOrConnectServer,
  disconnectServer,
  listConnected,
  listTools,
  callToolResilient,
  closeAllClients,
  withCancellation,
} from "./mcpClient.js";
import { promptForArgs, runAgentTurn, CANCELLED } from "./suggest.js";
import { mainPalette, BUILTIN_COMMANDS, formatParamHint } from "./palette.js";
import { compressIfNeeded } from "./history.js";
import { routeChat } from "./router.js";
import { colors, style } from "./colors.js";
import { search } from "@inquirer/prompts";
import { renderResult } from "./render.js";

async function handleChat(text, toolCache, messages, apiKey) {
  messages.push({ role: "user", content: text });

  // Improvement 3 (integration): compressIfNeeded now returns a result
  // object instead of a bare array, since it can fail. Surface the failure
  // as a visible warning rather than either crashing or silently discarding
  // an error the user has no way to see.
  const { messages: compressed, error: compressionError } = await compressIfNeeded(messages, routeChat);
  if (compressionError) {
    console.log(style.warning(`(history compression skipped: ${compressionError.message})`));
  }
  messages.length = 0;
  messages.push(...compressed);

  const flatTools = [...toolCache.entries()]
    .flatMap(([serverName, tools]) => tools.map((t) => ({ ...t, __server: serverName })))
    .sort((a, b) => a.__server.localeCompare(b.__server) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  const result = await runAgentTurn({
    messages,
    tools: flatTools,
    apiKey,
    userQuery: null,
    confirmTool: async (serverName, toolName, args) => {
      console.log(`\n${style.heading("Model wants to call")} ${style.toolName(toolName)} ${style.muted("on")} ${style.serverName(serverName)}:`);
      console.log(style.muted(JSON.stringify(args, null, 2)));
      const { ok } = await inquirer.prompt([{ type: "confirm", name: "ok", message: "Allow?", default: true }]);
      return ok;
    },
    executeTool: async (serverName, toolName, args, { signal } = {}) =>
      callToolResilient(serverName, getServer(serverName), toolName, args, { signal }),
  });

  console.log();
  if (result.text.startsWith("[stopped after")) console.log(style.warning(result.text));
}

async function dispatchBuiltin(command, toolCache, messages, apiKey, resultBuffer) {
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

    case "call": {
      const names = Object.keys(registered);
      if (names.length === 0) { console.log(style.warning("No servers registered.")); return; }
      const { name } = await inquirer.prompt([{ type: "list", name: "name", message: "Server:", choices: names }]);
      const entry = registered[name];
      const client = await getOrConnectServer(name, entry);
      const tools = toolCache.get(name) ?? await listTools(client);
      toolCache.set(name, tools);
      const { toolName } = await inquirer.prompt([
            { type: "list", name: "toolName", message: "Tool:", choices: tools.map((t) => t.name) },
          ]);
      const tool = tools.find((t) => t.name === toolName);
      const args = await promptForArgs(tool.inputSchema, resultBuffer);
      if (args === CANCELLED) { console.log(style.warning("Cancelled.")); return; }
      const result = await withCancellation((signal) => callToolResilient(name, entry, toolName, args, { signal }))();
      resultBuffer.push({ server: name, tool: toolName, args, mcpResult: result });
      renderResult(result);
      return;
    }
    case "results": {
      const entries = resultBuffer.list();
      if (entries.length === 0) {
        console.log(style.muted("No cached results yet."));
        return;
      }
      for (const e of entries) {
        const preview = e.text.length > 80 ? e.text.slice(0, 79) + "…" : e.text;
        console.log(`${style.bold(`#${e.index}`)} ${style.serverName(e.server)}/${style.toolName(e.tool)} ${style.muted(preview.replace(/\n/g, " "))}`);
      }
      return;
    }
    case "save": {
      const entries = resultBuffer.list();
      if (entries.length === 0) {
        console.log(style.warning("No cached results to save."));
        return;
      }
      const { n, path } = await inquirer.prompt([
        { type: "number", name: "n", message: "Result # to save:" },
        { type: "input", name: "path", message: "Save to path:" },
      ]);
      const entry = resultBuffer.get(n);
      if (!entry) { console.log(style.error(`No cached result #${n}.`)); return; }
      // Improvement 10: overwrite confirmation on `save`. Previously
      // fs.writeFileSync silently clobbered an existing file at the target
      // path with no warning -- a typo'd path colliding with an existing
      // file (e.g. a config or source file) destroyed it with no recovery
      // path other than external backups.
      if (fs.existsSync(path)) {
        const { confirmOverwrite } = await inquirer.prompt([
          { type: "confirm", name: "confirmOverwrite", message: `"${path}" already exists. Overwrite?`, default: false },
        ]);
        if (!confirmOverwrite) {
          console.log(style.muted("Cancelled."));
          return;
        }
      }
      fs.writeFileSync(path, entry.text);
      console.log(style.success(`Saved result #${n} to ${path}.`));
      return;
    }
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
  const resultBuffer = new ResultBuffer();

  console.log(style.heading("mcp-dev session"));
  console.log(style.muted("Press / for commands. Type freely to chat."));

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
      if (err?.name === "ExitPromptError") continue;
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
        if (err?.name === "ExitPromptError") continue;
        throw err;
      }
      selection = toolSelection;
    }

    if (selection.kind === "chat") {
      await handleChat(selection.raw, toolCache, messages, apiKey);
      continue;
    }
    if (selection.kind === "builtin") {
      await dispatchBuiltin(selection.raw, toolCache, messages, apiKey, resultBuffer);
      continue;
    }
    if (selection.kind === "tool-call") {
      const { server, tool, schema } = selection;
      let args;
      try {
        args = await promptForArgs(schema, resultBuffer);
      } catch (err) {
        if (err?.name === "ExitPromptError") { console.log(style.warning("Cancelled.")); continue; }
        throw err;
      }
      if (args === CANCELLED) {
        console.log(style.warning("Cancelled — missing required field."));
        continue;
      }
      const result = await withCancellation((signal) =>
        callToolResilient(server, registered[server], tool, args, { signal })
      )();

      resultBuffer.push({ server, tool, args, mcpResult: result });
      renderResult(result);
      continue;
    }
    if (selection.kind === "noop") continue;
  }
}