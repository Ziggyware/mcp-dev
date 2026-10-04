// src/session.js
//
// The interactive session: a persistent workspace over the registered servers.
// The loop itself is intentionally thin — every surface (prompt, picker,
// approval, forms) lives in its own module, and this file connects them to the
// MCP clients.

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_EXPORT, getServer, listServers } from "./config.js";
import {
  callToolResilient,
  closeAllClients,
  disconnectServer,
  getOrConnectServer,
  listConnected,
  listTools,
  onToolsChanged,
  withTimeout,
} from "./mcpClient.js";
import { CANCELLED, promptForArgs, runAgentTurn } from "./suggest.js";
import { ResultBuffer, walkPath } from "./resultBuffer.js";
import { formatParamHint } from "./palette.js";
import { compressIfNeeded } from "./history.js";
import { routeChat } from "./router.js";
import { colors, getColorMode, marks, setColorMode, style } from "./colors.js";
import { renderResult } from "./render.js";
import { formatTools } from "./toolDisplay.js";
import { cacheTools, getCachedTools, invalidateToolCache } from "./toolCache.js";
import { isInteractive } from "./terminal.js";
import { ApprovalStore } from "./approvals.js";
import { runWithSpinner } from "./spinner.js";
import { InputHistory, runPrompt } from "./inputPrompt.js";
import { readSessionInput, pickOne, approveToolCall, helpOverlayLines } from "./sessionPrompt.js";
import { promptPathValue, displayPath } from "./pathPrompt.js";
import { colorizeJsonText, formatJsonValue } from "./jsonText.js";
import { describeBufferEntry } from "./backrefs.js";
import { summarizeArgs } from "./argForm.js";

const TOOL_TIMEOUT_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 8_000;
const DOUBLE_CTRL_C_MS = 1_500;
const HISTORY_FILE = path.join(CONFIG_DIR_EXPORT, "session_history.json");

function sortedNames(servers) {
  return Object.keys(servers).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.slice(-500).filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    fs.mkdirSync(CONFIG_DIR_EXPORT, { recursive: true, mode: 0o700 });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.list().slice(-500)), { mode: 0o600 });
  } catch {
    // History is a convenience; never let a read-only home directory break the session.
  }
}

// --------------------------------------------------------------------- servers

async function refreshServer(name, ctx, { quiet = false } = {}) {
  const entry = getServer(name);
  if (!entry) throw new Error(`No server named "${name}".`);

  const outcome = await runWithSpinner(`connecting ${style.serverName(name)}`, async ({ signal }) => {
    const client = await getOrConnectServer(name, entry, { timeoutMs: DISCOVERY_TIMEOUT_MS, signal });
    const tools = await withTimeout(listTools(client, { timeout: DISCOVERY_TIMEOUT_MS, maxTotalTimeout: DISCOVERY_TIMEOUT_MS }), DISCOVERY_TIMEOUT_MS, `Listing tools for "${name}" timed out after ${DISCOVERY_TIMEOUT_MS}ms`);
    return { client, tools };
  });

  if (!outcome.ok) {
    if (!outcome.cancelled) console.log(style.error(outcome.error.message));
    return null;
  }

  const { client, tools } = outcome.value;
  ctx.toolCache.set(name, tools);
  ctx.cacheOrigin.set(name, "live");
  cacheTools(name, entry, tools);

  if (!ctx.subscriptions.has(name)) {
    ctx.subscriptions.set(name, onToolsChanged(client, () => {
      ctx.toolCache.delete(name);
      ctx.cacheOrigin.delete(name);
      invalidateToolCache(name);
    }));
  }
  if (!quiet) {
    console.log(style.success(`Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"} from "${name}".`));
  }
  return tools;
}

async function ensureLiveTools(name, ctx) {
  if (ctx.toolCache.has(name) && ctx.cacheOrigin.get(name) === "live") return ctx.toolCache.get(name);
  return refreshServer(name, ctx, { quiet: true });
}

function hydrateCachedTools(registered, ctx) {
  for (const [name, entry] of Object.entries(registered)) {
    const cached = getCachedTools(name, entry, { allowStale: true });
    if (cached) {
      ctx.toolCache.set(name, cached.tools);
      ctx.cacheOrigin.set(name, "cached");
    }
  }
}

// ------------------------------------------------------------------- tool call

async function invokeTool({ server, tool, args, ctx }) {
  const entry = getServer(server);
  if (!entry) {
    console.log(style.error(`No server named "${server}".`));
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Tool call ${server}/${tool} timed out after ${TOOL_TIMEOUT_MS}ms`)),
    TOOL_TIMEOUT_MS
  );
  const label = `calling ${style.serverName(server)}/${style.toolName(tool)} ${colors.faint(summarizeArgs(args))}`;
  const outcome = await runWithSpinner(
    label,
    ({ signal }) => callToolResilient(server, entry, tool, args, {
      signal,
      timeout: TOOL_TIMEOUT_MS,
      maxTotalTimeout: TOOL_TIMEOUT_MS,
    }),
    { signal: controller.signal, listen: true }
  );
  clearTimeout(timer);

  if (!outcome.ok) {
    if (outcome.cancelled) console.log(style.warning("Cancelled before the tool answered."));
    else console.log(style.error(outcome.error.message));
    return null;
  }

  const result = outcome.value;
  const index = ctx.resultBuffer.push({ server, tool, args, mcpResult: result });
  const header = `${marks.ok()} ${style.serverName(server)}/${style.toolName(tool)} ${colors.faint(summarizeArgs(args))}`;
  console.log(header);
  renderResult(result);
  console.log(colors.faint(`  cached as ${style.warning(`#${index}`)} — reuse with ${style.key(`!${index}.field`)} or ${style.key("!!")} · /results lists everything`));
  return result;
}

async function openTool({ server, tool, presetArgs = null, ctx }) {
  let tools;
  try {
    tools = await ensureLiveTools(server, ctx);
  } catch (error) {
    console.log(style.error(error.message));
    return;
  }
  if (!tools) return;
  const definition = tools.find((item) => item.name === tool);
  if (!definition) {
    console.log(style.warning(`Tool "${tool}" is no longer available on "${server}". The live list was reloaded.`));
    return;
  }

  let initialArgs = presetArgs;
  for (let attempt = 0; attempt < 2; attempt++) {
    const args = await promptForArgs(definition.inputSchema, ctx.resultBuffer, {
      title: `${server}/${definition.name}`,
      cwd: ctx.cwd,
      initialArgs,
    });
    if (args === CANCELLED) {
      console.log(colors.faint("Cancelled."));
      return;
    }

    const approval = await approveToolCall({ server, tool: definition.name, args, approvals: ctx.approvals });
    if (approval.edit) {
      initialArgs = args;
      console.log(colors.faint("Edit the arguments, then approve the call."));
      continue;
    }
    if (!approval.approved) {
      console.log(colors.faint("Skipped."));
      return;
    }
    await invokeTool({ server, tool: definition.name, args, ctx });
    return;
  }
}

// ----------------------------------------------------------------------- chat

function chatUnavailable() {
  console.log(style.warning("Chat is off: ANTHROPIC_API_KEY is not set in this shell."));
  console.log(colors.faint("  Everything else works without it:"));
  console.log(`    ${style.toolName("/servers")}            list servers            ${colors.faint("(then /call)")}`);
  console.log(`    ${style.toolName("/<server>/")}          connect and pick a tool`);
  console.log(`    ${style.toolName("/call")}               guided argument form`);
  console.log(colors.faint("  To enable chat: export ANTHROPIC_API_KEY=… and restart `mcp-dev session`."));
}

async function handleChat(text, ctx) {
  if (!String(text ?? "").trim()) return;
  if (!ctx.apiKey) {
    chatUnavailable();
    return;
  }
  const messages = ctx.messages;
  messages.push({ role: "user", content: text });
  const { messages: compressed, error: compressionError } = await compressIfNeeded(messages, routeChat);
  if (compressionError) console.log(style.warning(`History compression skipped: ${compressionError.message}`));
  messages.length = 0;
  messages.push(...compressed);

  const tools = [...ctx.toolCache.entries()]
    .flatMap(([server, serverTools]) => serverTools.map((tool) => ({ ...tool, __server: server })))
    .sort((a, b) => a.__server.localeCompare(b.__server) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  const result = await runAgentTurn({
    messages,
    tools,
    apiKey: ctx.apiKey,
    userQuery: null,
    confirmTool: async (server, tool, args) => {
      const approval = await approveToolCall({ server, tool, args, approvals: ctx.approvals });
      return Boolean(approval.approved);
    },
    executeTool: async (server, tool, args, { signal } = {}) => {
      const entry = getServer(server);
      if (!entry) throw new Error(`No server named "${server}".`);
      const outcome = await runWithSpinner(
        `model → ${style.serverName(server)}/${style.toolName(tool)}`,
        ({ signal: innerSignal }) => callToolResilient(server, entry, tool, args, {
          signal: innerSignal ?? signal,
          timeout: TOOL_TIMEOUT_MS,
          maxTotalTimeout: TOOL_TIMEOUT_MS,
        }),
        { listen: true }
      );
      if (!outcome.ok) throw outcome.error ?? new Error("Tool call cancelled");
      return outcome.value;
    },
    onToolResult: async ({ server, tool, args, result: mcpResult }) => {
      const index = ctx.resultBuffer.push({ server, tool, args, mcpResult });
      console.log(colors.faint(`  cached as #${index} (from the model)`));
    },
  });
  if (result.text.startsWith("[stopped after")) console.log(style.warning(result.text));
}

// -------------------------------------------------------------------- commands

function printResults(ctx) {
  const entries = ctx.resultBuffer.list();
  if (!entries.length) {
    console.log(colors.faint("No cached results yet. Every tool call is cached automatically."));
    return;
  }
  console.log(style.heading(`Cached results (${entries.length})`));
  for (const entry of [...entries].reverse()) {
    console.log(`  ${style.warning(`#${entry.index}`)}  ${describeBufferEntry(entry)}`);
    console.log(colors.faint(`       reuse: ${style.key(`!${entry.index}.field`)} · ${style.key(`!!`)} · /result ${entry.index} · /save ${entry.index} out.json`));
  }
}

function showCached(ref, ctx) {
  let trimmed = String(ref ?? "").trim();
  if (!trimmed) {
    printResults(ctx);
    return;
  }
  // `/result 2.name` and `!2.name` mean the same thing; accept both.
  if (/^(\d|!)/.test(trimmed) && !trimmed.startsWith("!")) trimmed = `!${trimmed}`;
  const direct = /^!(?:!|\d+)(?:\..+|\[.+)?$/.exec(trimmed);
  if (!direct) {
    console.log(style.error(`"${trimmed}" is not a cached reference. Try /results.`));
    return;
  }
  const baseMatch = /^!(?:!|(\d+))/.exec(trimmed);
  const entry = /^!!/.test(trimmed) ? ctx.resultBuffer.last() : ctx.resultBuffer.get(Number(baseMatch?.[1]));
  if (!entry) {
    console.log(style.error(`No cached result ${trimmed.split(".")[0]}. Run /results.`));
    return;
  }
  const suffix = trimmed.slice(baseMatch[0].length);
  console.log(`${style.warning(`#${entry.index}`)} ${style.serverName(entry.server)}/${style.toolName(entry.tool)} ${colors.faint(summarizeArgs(entry.args))}`);
  if (!suffix) {
    console.log(entry.text);
    return;
  }
  const jsonPath = suffix.startsWith(".") ? suffix.slice(1) : suffix;
  let parsed;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    console.log(style.error(`Result #${entry.index} is not JSON — cannot apply "${suffix}".`));
    return;
  }
  try {
    const value = walkPath(parsed, jsonPath);
    if (value === undefined) {
      console.log(style.error(`Path "${suffix}" was not found in result #${entry.index}.`));
      return;
    }
    for (const line of colorizeJsonText(formatJsonValue(value))) console.log(line);
  } catch (error) {
    console.log(style.error(error.message));
  }
}

async function saveCached(args, ctx) {
  const entries = ctx.resultBuffer.list();
  if (!entries.length) {
    console.log(style.warning("No cached results to save."));
    return;
  }
  let ref = args[0];
  if (!ref) {
    const picked = await pickOne({
      title: [style.heading("Save a cached result")],
      message: () => `${marks.arrow()} ${style.body("result")}`,
      items: [...entries].reverse().map((entry) => ({
        label: `#${entry.index} ${entry.server}/${entry.tool}`,
        insertText: `!${entry.index}`,
        description: `${entry.text.length} chars · ${entry.text.replace(/\s+/g, " ").slice(0, 48)}…`,
        value: `!${entry.index}`,
      })),
      ctx,
    });
    if (!picked) {
      console.log(colors.faint("Cancelled."));
      return;
    }
    ref = picked;
  }
  if (!/^!/.test(ref)) ref = `!${ref}`;

  let target = args[1];
  if (!target) {
    const answer = await promptPathValue({
      label: `Save ${ref} to`,
      baseDir: ctx.cwd,
      mode: "file",
      initialText: "",
    });
    if (!answer.ok) {
      console.log(colors.faint("Cancelled."));
      return;
    }
    target = answer.text.trim();
  }
  if (!target) return;

  const baseMatch = /^!(?:!|(\d+))/.exec(ref);
  const entry = /^!!/.test(ref) ? ctx.resultBuffer.last() : ctx.resultBuffer.get(Number(baseMatch[1]));
  if (!entry) {
    console.log(style.error(`No cached result ${ref}.`));
    return;
  }
  const suffix = ref.slice(baseMatch[0].length);
  let text = entry.text;
  if (suffix) {
    try {
      const value = walkPath(JSON.parse(entry.text), suffix.replace(/^\./, ""));
      text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch (error) {
      console.log(style.error(`Cannot resolve ${ref}: ${error.message}`));
      return;
    }
  }
  const absolute = path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target);
  if (fs.existsSync(absolute)) {
    const answer = await pickOne({
      title: [`${marks.warn()} ${colors.warning(`"${displayPath(absolute, { baseDir: ctx.cwd })}" already exists.`)}`],
      items: [
        { label: "cancel", insertText: "cancel", description: "keep the existing file", value: "cancel" },
        { label: "overwrite", insertText: "overwrite", description: "replace its contents", value: "overwrite" },
      ],
      ctx,
    });
    if (answer !== "overwrite") {
      console.log(colors.faint("Cancelled."));
      return;
    }
  }
  try {
    fs.writeFileSync(absolute, text);
    console.log(style.success(`Saved ${ref} → ${displayPath(absolute, { baseDir: ctx.cwd })} (${text.length} chars)`));
  } catch (error) {
    console.log(style.error(`Could not write ${absolute}: ${error.message}`));
  }
}

async function dispatchCommand(route, ctx) {
  const { command, args } = route;
  const name = command.name;

  switch (name) {
    case "help":
    case "keys": {
      console.log(helpOverlayLines(ctx).join("\n"));
      return;
    }
    case "servers": {
      const servers = listServers();
      const names = sortedNames(servers);
      if (!names.length) {
        console.log(colors.faint("No servers registered. Run `mcp-dev register <name>` in another terminal."));
        return;
      }
      const connected = new Set(listConnected());
      for (const server of names) {
        const origin = ctx.cacheOrigin.get(server);
        const tools = ctx.toolCache.get(server);
        const state = connected.has(server) ? colors.success("connected") : origin === "cached" ? colors.warning("cached") : colors.faint("idle");
        const detail = tools ? `${tools.length} tools` : "tools not loaded";
        console.log(`  ${style.serverName(server.padEnd(18))} ${state.padEnd(12)} ${colors.faint(detail)}${servers[server].description ? colors.faint(`  ${servers[server].description}`) : ""}`);
      }
      console.log(colors.faint("  /connect <server> to load tools · /<server>/ to browse · /call to run one"));
      return;
    }
    case "connect": {
      const names = sortedNames(listServers());
      const target = args[0] ?? await pickOne({
        title: [style.heading("Connect a server")],
        items: names.map((server) => ({ label: server, insertText: server, description: listServers()[server].description ?? "", value: server })),
        ctx,
      });
      if (!target) {
        console.log(colors.faint("Cancelled."));
        return;
      }
      await refreshServer(target, ctx);
      return;
    }
    case "disconnect": {
      const connectedNames = listConnected();
      if (!connectedNames.length) {
        console.log(style.warning("No server connections are open."));
        return;
      }
      const target = args[0] ?? await pickOne({
        title: [style.heading("Disconnect a server")],
        items: connectedNames.map((server) => ({ label: server, insertText: server, description: "connected", value: server })),
        ctx,
      });
      if (!target) {
        console.log(colors.faint("Cancelled."));
        return;
      }
      const closed = await disconnectServer(target);
      ctx.subscriptions.get(target)?.();
      ctx.subscriptions.delete(target);
      if (ctx.toolCache.has(target)) ctx.cacheOrigin.set(target, "cached");
      if (closed) console.log(style.success(`Disconnected "${target}".`));
      return;
    }
    case "tools": {
      const names = sortedNames(listServers());
      const target = args[0] ?? await pickOne({
        title: [style.heading("Inspect a server's tools")],
        items: names.map((server) => ({ label: server, insertText: server, description: listServers()[server].description ?? "", value: server })),
        ctx,
      });
      if (!target) return;
      const tools = await refreshServer(target, ctx, { quiet: true });
      if (!tools) return;
      console.log(formatTools(tools));
      console.log(colors.faint(`  run one with /${target}/<tool> or /call ${target}`));
      return;
    }
    case "refresh": {
      const names = sortedNames(listServers());
      const target = args[0] ?? await pickOne({
        title: [style.heading("Refresh a server's tools")],
        items: names.map((server) => ({ label: server, insertText: server, description: targetsTools(ctx, server), value: server })),
        ctx,
      });
      if (!target) return;
      await refreshServer(target, ctx);
      return;
    }
    case "call": {
      const names = sortedNames(listServers());
      let server = args[0];
      if (!server) {
        server = await pickOne({
          title: [style.heading("Call a tool — pick a server")],
          items: names.map((entry) => ({ label: entry, insertText: entry, description: targetsTools(ctx, entry), value: entry })),
          ctx,
        });
      }
      if (!server) {
        console.log(colors.faint("Cancelled."));
        return;
      }
      if (!getServer(server)) {
        console.log(style.error(`No server named "${server}".`));
        return;
      }
      const tools = await ensureLiveTools(server, ctx);
      if (!tools?.length) {
        console.log(style.warning(`"${server}" reports no tools.`));
        return;
      }
      let tool = args[1];
      if (!tool) {
        tool = await pickOne({
          title: [style.heading(`Call a tool on ${server}`)],
          message: () => `${marks.arrow()} ${style.body("tool")}`,
          items: tools.map((entry) => ({
            label: entry.name,
            insertText: entry.name,
            description: [entry.description, formatParamHint(entry.inputSchema) ? colors.faint(formatParamHint(entry.inputSchema)) : ""].filter(Boolean).join("  "),
            value: entry.name,
          })),
          ctx,
        });
      }
      if (!tool) {
        console.log(colors.faint("Cancelled."));
        return;
      }
      await openTool({ server, tool, ctx });
      return;
    }
    case "ask": {
      if (!ctx.apiKey) {
        chatUnavailable();
        return;
      }
      let question = args.join(" ").trim();
      if (!question) {
        const answer = await runPrompt({
          title: [style.heading("Ask the assistant")],
          message: () => `${marks.arrow()} ${style.body("question")}`,
          allowNewline: true,
          submitKey: "enter",
          hints: () => ["Enter ask", "Ctrl+Enter newline", "Esc cancel"],
        });
        if (!answer.ok) return;
        question = answer.text.trim();
      }
      if (!question) return;
      await handleChat(question, ctx);
      return;
    }
    case "results":
      printResults(ctx);
      return;
    case "result":
      showCached(args[0], ctx);
      return;
    case "save":
      await saveCached(args, ctx);
      return;
    case "history": {
      if (!ctx.messages.length) {
        console.log(colors.faint("Conversation history is empty."));
        return;
      }
      for (const message of ctx.messages) {
        const content = typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join(" ")
            : JSON.stringify(message.content);
        const role = message.role === "user" ? colors.green("you") : colors.cyan("model");
        console.log(`${role} ${colors.faint(`(${message.role})`)}  ${content.replace(/\s+/g, " ").slice(0, 160)}${content.length > 160 ? "…" : ""}`);
      }
      return;
    }
    case "clear":
      ctx.messages.length = 0;
      console.log(style.success("Conversation history cleared. Connections and cached results remain."));
      return;
    case "cd": {
      if (args[0]) {
        const target = path.isAbsolute(args[0]) ? args[0] : path.resolve(ctx.cwd, args[0]);
        try {
          const stat = fs.statSync(target);
          if (!stat.isDirectory()) {
            console.log(style.error(`Not a directory: ${target}`));
            return;
          }
          ctx.cwd = target;
          console.log(style.success(`Path prompts now start in ${displayPath(ctx.cwd, { baseDir: process.cwd() })}`));
          return;
        } catch (error) {
          console.log(style.error(`Cannot use ${target}: ${error.message}`));
          return;
        }
      }
      const answer = await promptPathValue({ label: "Change directory", baseDir: ctx.cwd, mode: "dir" });
      if (!answer.ok) return;
      const chosen = answer.text.trim();
      if (!chosen) return;
      const resolved = path.isAbsolute(chosen) ? chosen : path.resolve(ctx.cwd, chosen);
      try {
        if (!fs.statSync(resolved).isDirectory()) {
          console.log(style.error(`Not a directory: ${resolved}`));
          return;
        }
        ctx.cwd = resolved;
        console.log(style.success(`Path prompts now start in ${displayPath(ctx.cwd, { baseDir: process.cwd() })}`));
      } catch (error) {
        console.log(style.error(`Cannot use ${resolved}: ${error.message}`));
      }
      return;
    }
    case "pwd":
      console.log(displayPath(ctx.cwd, { baseDir: process.cwd() }));
      return;
    case "approvals": {
      if (args[0] === "clear") {
        const removed = ctx.approvals.revoke("all");
        console.log(removed ? style.success(`Cleared ${removed} approval grant${removed === 1 ? "" : "s"}.`) : colors.faint("Nothing to clear."));
        return;
      }
      const grants = ctx.approvals.list();
      if (!grants.length) {
        console.log(colors.faint("No auto-approvals. Every tool call asks first; answer `a` to remember one."));
        return;
      }
      console.log(style.heading("Auto-approved in this session"));
      for (const grant of grants) console.log(`  ${style.warning(grant.scope)}  ${colors.faint(grant.label)}`);
      console.log(colors.faint("  revoke with /untrust <scope> · clear everything with /approvals clear"));
      return;
    }
    case "untrust": {
      const scope = args[0];
      if (!scope) {
        const grants = ctx.approvals.list();
        if (!grants.length) {
          console.log(colors.faint("No grants to revoke."));
          return;
        }
        for (const grant of grants) console.log(`  ${style.warning(grant.scope)}  ${colors.faint(grant.label)}`);
        console.log(colors.faint("  /untrust <scope> · /untrust all"));
        return;
      }
      const removed = ctx.approvals.revoke(scope);
      console.log(removed ? style.success(`Revoked ${scope}.`) : style.warning(`No grant matching "${scope}".`));
      return;
    }
    case "color": {
      const mode = args[0];
      if (!mode) {
        const chosen = await pickOne({
          title: [style.heading(`Colour mode: ${getColorMode()}`)],
          items: ["auto", "always", "never", "basic"].map((value) => ({
            label: value,
            insertText: value,
            description: value === getColorMode() ? "current" : "",
            value,
          })),
          ctx,
        });
        if (!chosen) return;
        setColorMode(chosen);
        console.log(style.success(`Colour mode: ${chosen}`));
        return;
      }
      if (!["auto", "always", "never", "basic"].includes(mode)) {
        console.log(style.error(`Unknown colour mode "${mode}" — use auto, always, never, or basic.`));
        return;
      }
      setColorMode(mode);
      console.log(style.success(`Colour mode: ${mode}`));
      return;
    }
    case "exit":
    case "quit":
      return { exit: true };
    default:
      console.log(style.warning(`Unknown command /${name}. Try /help.`));
      return;
  }
}

function targetsTools(ctx, server) {
  const tools = ctx.toolCache.get(server);
  const origin = ctx.cacheOrigin.get(server);
  if (!tools) return "tools not loaded";
  return `${tools.length} tools${origin === "cached" ? " (cached)" : ""}`;
}

// --------------------------------------------------------------------- routes

async function handleRoute(route, ctx) {
  switch (route.type) {
    case "chat":
      await handleChat(route.message, ctx);
      return;
    case "slash-chat":
      await handleChat(route.message, ctx);
      return;
    case "command": {
      const outcome = await dispatchCommand(route, ctx);
      return outcome?.exit ? { exit: true } : undefined;
    }
    case "server": {
      const tools = await ensureLiveTools(route.server, ctx);
      if (!tools?.length) {
        console.log(style.warning(`"${route.server}" reports no tools.`));
        return;
      }
      const candidates = route.filter
        ? tools.filter((tool) => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(route.filter.toLowerCase()))
        : tools;
      const tool = await pickOne({
        title: [
          style.heading(`${route.server} — ${tools.length} tools`),
          colors.faint(route.filter ? `  filtered by "${route.filter}"` : "  ↑/↓ choose, type to filter"),
        ],
        message: () => `${marks.arrow()} ${style.body("tool")}`,
        items: (candidates.length ? candidates : tools).map((entry) => ({
          label: entry.name,
          insertText: entry.name,
          description: [entry.description, formatParamHint(entry.inputSchema) ? colors.faint(formatParamHint(entry.inputSchema)) : ""].filter(Boolean).join("  "),
          value: entry.name,
        })),
        ctx,
      });
      if (!tool) {
        console.log(colors.faint("Cancelled."));
        return;
      }
      await openTool({ server: route.server, tool, ctx });
      return;
    }
    case "tool": {
      await openTool({ server: route.server, tool: route.tool, presetArgs: route.inline ? route.args : null, ctx });
      return;
    }
    case "cache":
      showCached(route.ref, ctx);
      return;
    case "unknown": {
      console.log(style.warning(`"${route.input}" is not a command, a server, or a loaded tool.`));
      console.log(colors.faint("  /help lists commands · /servers lists servers · /<server>/ browses tools"));
      return;
    }
    case "empty":
    default:
      return;
  }
}

// ------------------------------------------------------------------- lifecycle

function greeting(ctx) {
  const names = sortedNames(listServers());
  const lines = [];
  lines.push(`${style.heading("mcp-dev session")} ${colors.faint("— approval-first MCP workspace")}`);
  if (!names.length) {
    lines.push(`${marks.warn()} ${colors.warning("no servers registered yet")} ${colors.faint("· run `mcp-dev register files --command npx --args '…'` in another terminal")}`);
  } else {
    lines.push(colors.faint(`  ${names.length} server${names.length === 1 ? "" : "s"}: ${names.join(", ")}`));
    lines.push(colors.faint(`  ${ctx.toolCache.size} cached tool set${ctx.toolCache.size === 1 ? "" : "s"} ready · servers connect on demand`));
  }
  lines.push("");
  lines.push(`  ${style.toolName("/help")} or ${style.key("?")}     full guide and every key`);
  lines.push(`  ${style.toolName("/servers")}          list servers, then ${style.toolName("/call")} for a guided tool call`);
  lines.push(`  ${style.toolName("/<server>/")}         connect and browse one server's tools`);
  lines.push(`  ${style.toolName("!3")}                reuse a cached result ${colors.faint("(/results lists them)")}`);
  if (!ctx.apiKey) lines.push(`  ${colors.faint("chat is off until ANTHROPIC_API_KEY is set — direct tool calls work now")}`);
  return lines.join("\n");
}

export async function startSession({ warm = false } = {}) {
  if (!isInteractive()) throw new Error("`mcp-dev session` requires an interactive terminal.");

  const registered = listServers();
  const history = new InputHistory({ entries: loadHistory() });
  const ctx = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    messages: [],
    toolCache: new Map(),
    cacheOrigin: new Map(),
    subscriptions: new Map(),
    resultBuffer: new ResultBuffer(),
    approvals: new ApprovalStore(),
    history,
    cwd: process.cwd(),
    servers: sortedNames(registered),
    connected: new Set(),
    descriptions: {},
  };
  // The palette reads tool metadata by server; the cache Map is the same object
  // under a name that reads better at the call sites.
  ctx.toolsByServer = ctx.toolCache;
  hydrateCachedTools(registered, ctx);

  console.log(greeting(ctx));

  let lastCancel = 0;
  let shuttingDown = false;

  // Ctrl+C inside a prompt is handled by the prompt itself; this listener
  // covers the gaps (between prompts, while a spinner runs) and the moments
  // when the terminal is in cooked mode and the kernel turns ^C into SIGINT.
  // Without it those presses kill the process outright, skipping cleanup and
  // leaving MCP child processes behind.
  const shutdownGracefully = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const unsubscribe of ctx.subscriptions.values()) unsubscribe?.();
    ctx.subscriptions.clear();
    try {
      await closeAllClients();
    } catch {
      // Best effort: we are on our way out.
    }
    saveHistory(ctx.history);
    console.log(style.success("session closed — all connections stopped"));
    process.exit(0);
  };
  const onSessionSigint = () => {
    if (shuttingDown) return;
    const now = Date.now();
    if (now - lastCancel < DOUBLE_CTRL_C_MS) {
      void shutdownGracefully();
      return;
    }
    lastCancel = now;
    console.log(colors.faint("Cancelled — press Ctrl+C again to exit, or ? for help."));
  };
  process.on("SIGINT", onSessionSigint);

  try {
    if (warm) {
      for (const name of sortedNames(registered)) await refreshServer(name, ctx, { quiet: true });
    }

    while (true) {
      const servers = listServers();
      ctx.servers = sortedNames(servers);
      ctx.connected = new Set(listConnected());
      ctx.descriptions = Object.fromEntries(Object.entries(servers).map(([name, entry]) => [name, entry.description ?? ""]));
      for (const name of [...ctx.toolCache.keys()]) {
        if (!(name in servers)) {
          ctx.toolCache.delete(name);
          ctx.cacheOrigin.delete(name);
        }
      }

      let input;
      try {
        input = await readSessionInput(ctx);
      } catch (error) {
        console.log(style.error(error.message));
        continue;
      }

      if (!input.ok) {
        if (input.reason === "eof") break;
        if (input.reason === "empty-escape" || input.reason === "not-a-tty") continue;
        const now = Date.now();
        if (now - lastCancel < DOUBLE_CTRL_C_MS) break;
        lastCancel = now;
        console.log(colors.faint("Cancelled — press Ctrl+C again to exit, or ? for help."));
        continue;
      }
      lastCancel = 0;

      try {
        const outcome = await handleRoute(input.route, ctx);
        if (outcome?.exit) break;
      } catch (error) {
        if (["ExitPromptError", "AbortPromptError", "CancelPromptError"].includes(error?.name)) {
          console.log(colors.faint("Cancelled."));
        } else {
          console.log(style.error(error.message));
        }
      }
    }
  } finally {
    // The handler deliberately stays installed for the rest of the process:
    // Ctrl+C during cleanup (or in the sliver between the loop ending and the
    // process exiting) would otherwise kill us by signal, skipping the closing
    // message and the connection cleanup we just did. `shuttingDown` makes any
    // later press a no-op.
    for (const unsubscribe of ctx.subscriptions.values()) unsubscribe();
    await closeAllClients();
    saveHistory(ctx.history);
  }

  console.log(style.success("session closed — all connections stopped"));
  return 0;
}
