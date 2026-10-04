// src/sessionInput.js
//
// Pure interpretation of what the user typed in the session prompt, plus the
// completion items and preview panel that explain it. Kept free of terminal
// code so it can be unit tested and reused (for example by the tool palette).

import { colors, getColorMode, marks, style } from "./colors.js";
import { COMMANDS_BY_NAME, SESSION_COMMANDS } from "./commands.js";
import { fuzzyMatch, rankByFuzzy } from "./fuzzy.js";
import { formatParamHint } from "./palette.js";
import { cachedRefItems } from "./backrefs.js";

/**
 * Split a line into the routing head and the remainder.
 *   "/call"                 -> { head: "call", args: "" }
 *   "/call demo tool"       -> { head: "call", args: "demo tool" }
 *   "/demo/"                -> { head: "demo", args: "", slash: true }
 *   "/demo/echo {\"a\":1}"   -> { head: "demo", args: "echo {\"a\":1}", slash: true }
 */
function splitRouting(raw) {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("/")) return { head: "", args: "", slash: false };
  const body = text.slice(1);
  const space = body.search(/\s/);
  const token = space === -1 ? body : body.slice(0, space);
  const rest = space === -1 ? "" : body.slice(space + 1).trim();
  const slash = token.indexOf("/");
  if (slash === -1) return { head: token, args: rest, slash: false };
  return { head: token.slice(0, slash), args: rest === "" ? token.slice(slash + 1) : `${token.slice(slash + 1)} ${rest}`.trim(), slash: true, filter: token.slice(slash + 1) };
}

export const INPUT_KINDS = ["empty", "chat", "slash-chat", "command", "server", "tool", "cache", "unknown"];

/**
 * Decide what the current line means. Mirrors the submit-time routing so the
 * preview panel can never disagree with what actually runs.
 */
export function interpretInput(raw, { servers = [], toolsByServer = new Map() } = {}) {
  const text = String(raw ?? "");
  const trimmed = text.trim();

  if (!trimmed) return { type: "empty", text };

  if (trimmed.startsWith("//")) {
    return { type: "slash-chat", text, message: trimmed.slice(1), items: [] };
  }

  if (/^!/i.test(trimmed)) return { type: "cache", ref: trimmed, text };

  if (trimmed.startsWith("/")) {
    const route = splitRouting(trimmed);
    const name = route.head;

    // Exact command names win over server names so `/call demo tool` always
    // means the command, not a server called "call".
    const command = COMMANDS_BY_NAME.get(name.toLowerCase());
    if (command && !(route.slash && servers.includes(name))) {
      const args = route.args ? splitArgs(route.args) : [];
      return { type: "command", command, args, rawArgs: route.args, text };
    }

    if (route.slash && servers.includes(name)) {
      const filter = route.args;
      if (!filter) return { type: "server", server: name, filter: "", text };
      const tools = toolsByServer.get(name) ?? [];
      const inlineArgs = cleanArgs(filter);
      if (inlineArgs?.args && tools.some((tool) => tool.name === inlineArgs.tool)) {
        return { type: "tool", server: name, tool: inlineArgs.tool, args: inlineArgs.args, inline: true, text };
      }
      const exact = tools.find((tool) => tool.name === filter.trim());
      if (exact) return { type: "tool", server: name, tool: exact.name, text };
      return { type: "server", server: name, filter, text };
    }

    if (!route.slash && servers.includes(name)) {
      return { type: "server", server: name, filter: "", text };
    }

    return { type: "unknown", input: trimmed, text };
  }

  return { type: "chat", text, message: trimmed, items: [] };
}

function splitArgs(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean);
}

/** `/server/tool {"path":"x"}` — inline JSON or key=value pairs. */
function cleanArgs(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const space = value.indexOf(" ");
  const tool = space === -1 ? value : value.slice(0, space);
  const rawArgs = space === -1 ? "" : value.slice(space + 1).trim();
  if (!rawArgs) return { tool, args: null };
  if (rawArgs.startsWith("{")) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { tool, args: parsed };
    } catch {
      return { tool, args: null };
    }
    return { tool, args: null };
  }
  return { tool, args: null };
}

function commandItems(needle) {
  const pool = SESSION_COMMANDS.map((command) => ({
    label: `/${command.name}`,
    insertText: `/${command.name}`,
    regionStart: 0,
    description: `${command.description}${command.requiresApiKey ? colors.faint(" (needs ANTHROPIC_API_KEY)") : ""}`,
    kind: "cmd",
    complete: true,
    trailingSpace: true,
    searchText: `${command.name} ${(command.aliases ?? []).join(" ")} ${command.description}`,
    command,
  }));
  return rankByFuzzy(pool, needle, { key: (item) => item.command.name }).map(({ item, indices }) => ({ ...item, indices }));
}

function serverItems(servers, ctx, needle) {
  const pool = servers.map((server) => {
    const tools = ctx.toolsByServer.get(server);
    const connected = ctx.connected?.has(server);
    const origin = ctx.cacheOrigin?.get(server);
    const state = connected ? "connected" : origin === "cached" ? "cached" : "idle";
    return {
      label: `/${server}/`,
      insertText: `/${server}/`,
      regionStart: 0,
      description: `${tools ? `${tools.length} tools` : "not loaded"} · ${state}${ctx.descriptions?.[server] ? ` · ${ctx.descriptions[server]}` : ""}`,
      kind: "server",
      complete: true,
      searchText: `${server} ${ctx.descriptions?.[server] ?? ""}`,
      server,
    };
  });
  return rankByFuzzy(pool, needle, { key: (item) => item.server }).map(({ item, indices }) => ({ ...item, indices }));
}

function toolItems(server, tools, needle) {
  const pool = tools.map((tool) => ({
    label: `${tool.name}`,
    insertText: tool.name,
    regionStart: `/${server}/`.length,
    description: [tool.description, formatParamHint(tool.inputSchema) ? colors.faint(formatParamHint(tool.inputSchema)) : ""].filter(Boolean).join("  "),
    kind: "tool",
    complete: true,
    searchText: `${tool.name} ${tool.description ?? ""}`,
    server,
    tool,
  }));
  const ranked = needle ? rankByFuzzy(pool, needle, { key: (item) => item.tool.name }) : pool.map((item) => ({ item, indices: [] }));
  return ranked.map(({ item, indices }) => ({ ...item, indices }));
}

/**
 * Completion items for the current line.
 * @returns {{items:Array, note:(string|null)}}
 */
export function completionsFor(text, ctx) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  const servers = ctx.servers ?? [];
  const apiKey = Boolean(ctx.apiKey);
  const items = [];

  if (!trimmed) {
    items.push(...commandItems("").slice(0, 6));
    items.push(...serverItems(servers, ctx, ""));
    if (apiKey) {
      items.push({
        label: "type a sentence to chat",
        insertText: "",
        description: "the assistant can call tools after you approve each call",
        kind: "hint",
        complete: false,
      });
    }
    return { items: items.slice(0, 12), note: apiKey ? null : "ANTHROPIC_API_KEY is not set — chat and /ask are unavailable, everything else works" };
  }

  if (trimmed.startsWith("!")) {
    const refs = cachedRefItems(ctx.resultBuffer, trimmed, { limit: 20 });
    return {
      items: refs,
      note: refs.length ? "Enter shows the cached value" : "No cached results yet — run a tool first, then reuse its output here",
    };
  }

  if (trimmed.startsWith("/")) {
    const route = splitRouting(trimmed);
    const server = route.head;

    if (server && COMMANDS_BY_NAME.has(server.toLowerCase()) && !(route.slash && servers.includes(server))) {
      // A command that takes arguments: complete the first argument with the
      // values it accepts instead of re-suggesting commands.
      const command = COMMANDS_BY_NAME.get(server.toLowerCase());
      const args = route.args ? route.args.split(/\s+/) : [];
      const wants = command.name;
      const argRegionStart = 1 + server.length + 1;
      if (wants === "color" && args.length <= 1) {
        return {
          items: ["auto", "always", "never", "basic"].map((value) => ({
            label: value,
            insertText: value,
            regionStart: argRegionStart,
            description: value === getColorMode() ? "current" : "",
            kind: "cmd",
            complete: true,
          })),
          note: "colour mode",
        };
      }
      if (wants === "untrust" && args.length <= 1) {
        return { items: [], note: "scope: a tool name, server:<name>, or all · /approvals lists them" };
      }
      if (wants === "approvals" && args.length <= 1) {
        return {
          items: [{ label: "clear", insertText: "clear", regionStart: argRegionStart, description: "revoke every grant", kind: "cmd", complete: true }],
          note: null,
        };
      }
    }

    if (route.slash && servers.includes(server)) {
      const tools = ctx.toolsByServer.get(server);
      const filter = route.args;
      if (!tools) {
        return {
          items: [{
            label: `/${server}/  connect and list tools`,
            insertText: `/${server}/`,
            regionStart: 0,
            description: "this server is not loaded yet — Enter connects on demand",
            kind: "server",
            complete: true,
          }],
          note: null,
        };
      }
      const list = toolItems(server, tools, filter ?? "");
      if (list.length) return { items: list, note: `${tools.length} tools on ${server}` };
      return {
        items: [{
          label: `/${server}/  refresh`,
          insertText: `/${server}/`,
          regionStart: 0,
          description: `no cached match for "${filter}" — Enter reconnects and reloads the live list`,
          kind: "server",
          complete: true,
        }],
        note: null,
      };
    }

    const needle = route.slash ? route.head : route.head;
    return { items: [...commandItems(needle), ...serverItems(servers, ctx, needle)].slice(0, 12), note: null };
  }

  // Plain text: an explicit chat preview plus anything else that matches.
  const matches = [
    ...commandItems(trimmed).filter((item) => fuzzyMatch(trimmed, item.command.name)),
    ...serverItems(servers, ctx, trimmed),
  ].slice(0, 4);
  if (!apiKey) {
    // Chat is not the default action when it cannot run: offer the entries that
    // do work, and say why the sentence itself is inert.
    return {
      items: matches.length ? matches : commandItems("").slice(0, 4),
      note: "chat is off without ANTHROPIC_API_KEY — Enter will explain how to enable it",
    };
  }
  const chat = {
    label: `Ask: ${trimmed}`,
    insertText: raw,
    regionStart: 0,
    description: "send to the assistant (Enter); it will ask before running tools",
    kind: "chat",
    complete: false,
    submitText: raw,
    chat: true,
  };
  return { items: [chat, ...matches], note: null };
}

/** Lines shown under the menu explaining the current selection or line. */
export function previewFor(text, ctx) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  const route = interpretInput(trimmed, ctx);

  if (route.type === "chat") {
    return ctx.apiKey
      ? [`${marks.info()} ${colors.faint("chat")} ${style.body(route.message)}`]
      : [
        `${marks.warn()} ${colors.warning("ANTHROPIC_API_KEY is not set")}`,
        colors.faint("Set it and restart the session to chat. Direct tool calls work now:"),
        colors.faint(`  /${ctx.servers?.[0] ?? "server"}/  or  /call`),
      ];
  }
  if (route.type === "command") {
    const lines = [`${marks.pointer()} ${style.toolName(`/${route.command.name}`)}  ${colors.faint(route.command.description)}`];
    if (route.command.usage) lines.push(colors.faint(`  usage: ${route.command.usage}`));
    if (route.command.examples?.length) lines.push(colors.faint(`  e.g.  ${route.command.examples[0]}`));
    if (route.command.keys?.length) lines.push(colors.faint(`  shortcut: ${route.command.keys.join(" · ")}`));
    if (route.command.requiresApiKey && !ctx.apiKey) lines.push(`${marks.warn()} ${colors.warning("requires ANTHROPIC_API_KEY")}`);
    return lines;
  }
  if (route.type === "server") {
    const tools = ctx.toolsByServer.get(route.server) ?? [];
    const lines = [`${marks.pointer()} ${style.serverName(route.server)} ${colors.faint(route.filter ? `filter "${route.filter}"` : "browse tools")}`];
    lines.push(colors.faint(tools.length ? `  ${tools.length} tools cached — Enter to pick one, /${route.server}/<tool> to open directly` : "  Enter connects (lazy) and lists its tools"));
    return lines;
  }
  if (route.type === "tool") {
    const tool = (ctx.toolsByServer.get(route.server) ?? []).find((item) => item.name === route.tool);
    const lines = [`${marks.pointer()} ${style.serverName(route.server)}/${style.toolName(route.tool)}`];
    if (tool?.description) lines.push(colors.faint(`  ${tool.description}`));
    const params = formatParamHint(tool?.inputSchema);
    if (params) lines.push(colors.faint(`  params: ${params}`));
    if (route.inline) lines.push(colors.success(`  inline arguments: ${JSON.stringify(route.args)} — the form opens prefilled`));
    else lines.push(colors.faint("  Enter opens the argument form with the approval screen"));
    return lines;
  }
  if (route.type === "slash-chat") {
    return [`${marks.info()} ${colors.faint("message beginning with /")} ${style.body(route.message)}`];
  }
  if (route.type === "cache") return cachePreview(route.ref, ctx);
  if (route.type === "unknown") {
    return [
      `${marks.warn()} ${colors.warning(`"${trimmed}" is not a command or server`)}`,
      colors.faint("  /help shows every command · /servers lists servers · plain text chats"),
    ];
  }
  return [];
}

function cachePreview(ref, ctx) {
  const buffer = ctx.resultBuffer;
  if (!buffer) return [];
  const last = buffer.last();
  const base = /^!!/.test(ref) ? last : buffer.get(Number(/^!(\d+)/.exec(ref)?.[1]));
  if (!base) {
    return [`${marks.warn()} ${colors.warning(`No cached result ${ref.split(".")[0]}`)}`, colors.faint("  /results lists what is available")];
  }
  return [
    `${marks.pointer()} ${style.warning(`#${base.index}`)} ${style.serverName(base.server)}/${style.toolName(base.tool)}`,
    colors.faint(`  ${base.text.length} chars · Enter prints it (paths: ${base.index ? `!${base.index}.field` : "!n.field"})`),
  ];
}

/**
 * The command table rendered for the help overlay: name, usage, description.
 * Commands the user can run right now sort first (undimmed).
 */
export function commandTableLines({ width = 100 } = {}) {
  const lines = [];
  const usageWidth = Math.min(34, Math.max(...SESSION_COMMANDS.map((command) => command.usage.length)) + 2);
  let group = null;
  for (const command of SESSION_COMMANDS) {
    if (command.group !== group) {
      group = command.group;
      lines.push("");
      lines.push(style.heading(group));
    }
    const alias = command.aliases?.length ? colors.faint(` (${command.aliases.map((name) => `/${name}`).join(", ")})`) : "";
    const usage = command.usage.padEnd(usageWidth);
    lines.push(`  ${style.toolName(usage)}${style.body(command.description)}${alias}`);
  }
  return lines;
}

export function parseCacheRef(ref) {
  return /^!(?:!|\d+)(?:\..+|\[.+)?$/.test(String(ref ?? "").trim());
}
