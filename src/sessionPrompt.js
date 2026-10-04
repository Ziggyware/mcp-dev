// src/sessionPrompt.js
//
// The session's interactive surfaces built on the shared input runtime:
//   - the main palette prompt,
//   - inline pickers (choosing a server or tool),
//   - the approval screen for tool calls,
//   - the help overlay.

import { runPrompt, InputHistory } from "./inputPrompt.js";
import { completionsFor, previewFor, commandTableLines, interpretInput } from "./sessionInput.js";
import { colors, marks, style } from "./colors.js";
import { colorizeJsonText, formatJsonValue } from "./jsonText.js";
import { isRiskyTool, riskyArgKeys } from "./approvals.js";
import { rankByFuzzy } from "./fuzzy.js";

/** One-line status bar above the prompt. */
export function statusLine(ctx) {
  const servers = ctx.servers ?? [];
  const connected = ctx.connected ?? new Set();
  const cached = ctx.toolsByServer?.size ?? 0;
  const parts = [];
  parts.push(`${style.heading("mcp-dev")}`);
  parts.push(servers.length ? `${servers.length} server${servers.length === 1 ? "" : "s"}` : colors.warning("no servers registered"));
  if (connected.size) parts.push(colors.success(`${connected.size} connected`));
  if (cached) parts.push(colors.faint(`${cached} cached`));
  if (ctx.resultBuffer?.list().length) parts.push(style.warning(`${ctx.resultBuffer.list().length} results`));
  if (ctx.approvals?.size) parts.push(colors.warning(`${ctx.approvals.size} auto-approve`));
  parts.push(ctx.apiKey ? colors.success("chat ready") : colors.faint("chat off"));
  parts.push(colors.path(ctx.cwd ?? process.cwd()));
  return `  ${parts.join(colors.faint(" · "))}`;
}

export function hintsFor(state, ctx) {
  const text = state.line.text;
  // Inside a session the output lives in a scrollable transcript, so the footer
  // says so instead of leaving the user to guess how to reach past results.
  const scroll = ctx?.screen ? "PgUp scroll" : null;
  const finish = ctx?.screen ? "Ctrl+D exit" : "Ctrl+C cancel";
  if (text.startsWith("!")) return ["Enter show value", "Tab complete path", "Esc clear", scroll].filter(Boolean);
  if (state.search) return ["Enter accept", "Ctrl+R next", "Esc cancel"];
  if (state.entries.length) return ["Tab complete", "↑/↓ choose", "Enter run", "Ctrl+Enter newline", scroll, "? help"].filter(Boolean);
  return ["Enter run", "Ctrl+Enter newline", "/ commands", "! cached values", scroll, "? help", finish].filter(Boolean);
}

/**
 * Read one line from the user, resolving to the interpretation of the input.
 * @returns {Promise<{ok:boolean, reason?:string, raw?:string, route?:object}>}
 */
export async function readSessionInput(ctx) {
  const screen = ctx.screen ?? null;
  // The status bar belongs to the screen's top row; the inline fallback keeps
  // it as the first title line, exactly as before.
  screen?.setStatus(statusLine(ctx));
  const result = await runPrompt({
    screen,
    title: (state) => {
      const hint = state.line.text ? [] : [colors.faint("  Type a sentence, / for commands, /server/ for tools, ! for cached results")];
      return screen ? hint : [statusLine(ctx), ...hint];
    },
    message: () => marks.arrow(),
    submitKey: "enter",
    allowNewline: true,
    history: ctx.history ?? new InputHistory(),
    menuSize: 6,
    status: null,
    completions: (text) => completionsFor(text, ctx),
    preview: (state) => previewFor(state.line.text, ctx),
    hints: (state) => hintsFor(state, ctx),
    onKey: (event, api) => {
      const empty = !api.line.text;
      if (event.name === "char" && event.text === "?" && empty) {
        api.openOverlay(helpOverlayLines(ctx, api.state));
        return true;
      }
      if (event.name === "escape" && empty) {
        // Nothing to clear: leave the prompt like Esc in a shell does, without
        // counting as a cancel (the session just shows a fresh prompt).
        api.close("empty-escape");
        return true;
      }
      return false;
    },
    validate: (text) => {
      if (!String(text).trim() && !String(text).includes("\n")) return "Type something, or press ? for help · Ctrl+D exits";
      return true;
    },
  });

  if (!result.ok) return result;
  const route = interpretInput(result.text, ctx);
  return { ok: true, raw: result.text, route };
}

/** Fuzzy picker used by /call, /connect, /tools, and /disconnect. */
export async function pickOne({ title, message = "❯", items, ctx, allowEmpty = false }) {
  const result = await runPrompt({
    screen: ctx?.screen ?? undefined,
    title,
    message,
    menuSize: 10,
    status: { text: "↑/↓ choose · Enter select · Esc cancel", tone: "info" },
    completions: (input) => ({ items: rankByFuzzy(items, input, { key: (item) => `${item.label} ${item.description ?? ""}` }).map(({ item, indices }) => ({ ...item, indices })) }),
    hints: () => ["type to filter", "↑/↓ choose", "Enter select", "Esc cancel"],
    validate: () => true,
  });
  if (!result.ok) return null;
  const selected = items.find((item) => item.insertText === result.text || item.label === result.text);
  if (selected) return selected.value;
  if (allowEmpty && !result.text.trim()) return null;
  // Enter on a filtered list with no explicit match: use the first suggestion.
  const ranked = rankByFuzzy(items, result.text, { key: (item) => `${item.label} ${item.description ?? ""}` });
  return ranked[0]?.item.value ?? null;
}

/** Keyboard + input reference rendered by `?` and `/keys`. */
export function helpOverlayLines(ctx, state = {}) {
  const lines = [];
  lines.push(style.heading("mcp-dev session — input guide"));
  lines.push("");
  lines.push(style.subheading("What you can type"));
  lines.push(`  ${style.toolName("plain text".padEnd(22))}${colors.faint(ctx.apiKey ? "chat with the assistant (tools require approval)" : "chat needs ANTHROPIC_API_KEY")}`);
  lines.push(`  ${style.toolName("/command".padEnd(22))}${colors.faint("run a session command, e.g. /servers, /call, /cd")}`);
  lines.push(`  ${style.toolName("/server/".padEnd(22))}${colors.faint("connect on demand and pick one of its tools")}`);
  lines.push(`  ${style.toolName("/server/tool".padEnd(22))}${colors.faint("open a tool directly; add {\"k\":\"v\"} for inline args")}`);
  lines.push(`  ${style.toolName("!3  !3.path  !!".padEnd(22))}${colors.faint("reuse a cached result — /results lists the references")}`);
  lines.push(`  ${style.toolName("//message".padEnd(22))}${colors.faint("send a chat message that starts with /")}`);
  lines.push("");
  lines.push(style.subheading("Keys"));
  const keys = [
    ["Enter", "run the line (send a chat message, run a command, open a tool)"],
    ["Ctrl+Enter", "insert a newline — Shift+Enter and Alt+Enter work too"],
    ["Tab", "complete the highlighted suggestion, else insert a tab"],
    ["Shift+Tab", "previous suggestion / previous form field"],
    ["↑ / ↓", "move through suggestions, then history"],
    ["← / →", "move the cursor; Ctrl or Alt + ← / → moves by word"],
    ["Ctrl+A / Ctrl+E", "jump to start / end of the line"],
    ["Ctrl+W, Ctrl+Backspace", "delete the previous word"],
    ["Ctrl+U / Ctrl+K", "delete to start / end of the line · Ctrl+Y restores"],
    ["Ctrl+R", "search history"],
    ["PgUp / PgDn", "scroll the transcript a page; works even while a call is running"],
    ["Shift+↑ / Shift+↓", "scroll one line · Ctrl+Home top · Ctrl+End newest output"],
    ["Mouse wheel", "scroll the transcript (hold Shift to select text) · /mouse toggles"],
    ["Ctrl+L", "clear the transcript and start the view fresh"],
    ["Esc", "clear the line (Ctrl+Y restores); on an empty line, exit the prompt"],
    ["Ctrl+C", "cancel the line; press twice in a row to leave the session"],
    ["Ctrl+D", "exit the session from an empty line"],
    ["?", "toggle this guide from an empty line"],
  ];
  for (const [key, description] of keys) lines.push(`  ${colors.bold(key.padEnd(22))}${colors.faint(description)}`);

  lines.push("");
  lines.push(style.subheading("Cached results"));
  lines.push(colors.faint("  Every tool call is cached in order. Reuse it in any argument prompt:"));
  lines.push(`  ${style.toolName("!3")} whole result · ${style.toolName("!3.rows[0].id")} inside it · ${style.toolName("!!")} the most recent`);
  lines.push(colors.faint("  Type ! in an argument field to see the paths that are available."));
  lines.push("");
  lines.push(style.subheading("Approvals"));
  lines.push(colors.faint("  Tool calls always show their exact arguments first. Answer y to run once,"));
  lines.push(colors.faint("  a to always allow that tool in this session, A for its server, * for everything."));
  lines.push(colors.faint("  Review or clear grants any time with /approvals and /untrust."));
  lines.push("");
  lines.push(style.subheading("Commands"));
  lines.push(...commandTableLines());
  return lines;
}

/**
 * Approval screen for a tool call. Returns
 * `{approved:boolean, remember?:string, edit?:boolean}`.
 */
export async function approveToolCall({ server, tool, args, approvals, argSummary = null, screen = undefined }) {
  if (approvals?.isGranted(server, tool)) {
    console.log(colors.muted(`auto-approved by a session grant — ${marks.ok()} ${style.serverName(server)}/${style.toolName(tool)}`));
    return { approved: true, auto: true };
  }

  const risky = isRiskyTool(tool);
  const sensitive = risky ? riskyArgKeys(args) : [];
  const argsJson = formatJsonValue(args, { maxString: 200 });
  const header = [];
  header.push(`${style.heading("about to call")} ${style.serverName(server)}/${style.toolName(tool)}`);
  if (risky) header.push(`${marks.warn()} ${colors.warning("this tool name suggests it writes or deletes data — read the arguments carefully")}`);
  for (const line of colorizeJsonText(argsJson)) header.push(`  ${line}`);
  if (sensitive.length) header.push(colors.faint(`  arguments touching: ${sensitive.join(", ")}`));
  if (argSummary) header.push(colors.faint(`  ${argSummary}`));

  const granted = approvals?.list() ?? [];
  if (granted.length) header.push(colors.faint(`  session grants: ${granted.map((entry) => entry.scope).join(", ")}`));

  const result = await runPrompt({
    screen,
    title: header,
    message: () => `${marks.arrow()} ${style.body("run?")}`,
    menuSize: 0,
    status: { text: "Enter/y run once · a always this tool · A always this server · * allow everything · e edit arguments · n/Esc skip", tone: "info" },
    hints: () => ["y run", "a always tool", "A always server", "* allow all", "e edit", "n skip"],
    validate: () => true,
    onKey: (event, api) => {
      const key = event.name === "char" && event.text ? event.text : null;
      if (event.name === "enter" || (key && key.toLowerCase() === "y")) {
        api.submit("");
        return true;
      }
      if (event.name === "escape" || (key && key.toLowerCase() === "n")) {
        api.close("declined");
        return true;
      }
      if (key === "a") { approvals?.grantTool(server, tool); api.submit(""); return true; }
      if (key === "A") { approvals?.grantServer(server); api.submit(""); return true; }
      if (key === "*") { approvals?.grantAll(); api.submit(""); return true; }
      if (key === "e") {
        console.log(colors.faint("edit the arguments in the form below"));
        api.close("edit");
        return true;
      }
      if (event.name === "char" && event.text && !["y", "n", "a", "A", "*", "e"].includes(event.text)) {
        api.setTransient(`Unknown answer "${event.text}" — y run · a always tool · A always server · * allow all · e edit · n skip`, "warn", { ttl: 6000 });
        return true;
      }
      return false;
    },
  });

  if (!result.ok) return { approved: false, reason: result.reason };
  return { approved: true };
}

/** Reusable "press any key to continue" for pages of output. */
export async function waitForKey({ title, message = "❯" }) {
  const result = await runPrompt({
    title,
    message,
    menuSize: 0,
    validate: () => true,
  });
  return result.ok;
}
