import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { redactUrl } from "./terminal.js";

const activeClients = new Set();
const sessionClients = new Map();
const connectingClients = new Map();
const toolChangeListeners = new WeakMap();
const stderrBuffers = new WeakMap();
const MAX_STDERR_BYTES = 4_096;
const MAX_TOOL_PAGES = 100;
const MAX_TOOLS = 10_000;

function winCliQuote(arg) {
  let result = String(arg).replace(/(\\*)"/g, "$1$1\\\"");
  result = result.replace(/(\\+)$/, "$1$1");
  return `"${result}"`;
}

function cmdMetaEscape(quotedArg) {
  return quotedArg.replace(/[()%!^<>&|;,]/g, "^$&");
}

function buildWindowsCommandLine(command, args) {
  return [command, ...args].map((arg) => cmdMetaEscape(winCliQuote(arg))).join(" ");
}

function resolveWindowsCommand(command, args) {
  if (process.platform !== "win32") return { command, args };
  const hasPathSeparator = /[\\/]/.test(command);
  const hasExplicitExt = /\.(exe|cmd|bat|com)$/i.test(command);
  if (hasPathSeparator || hasExplicitExt) return { command, args };
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  return { command: comspec, args: ["/d", "/s", "/c", buildWindowsCommandLine(command, args)] };
}

const DEFAULT_ENV_ALLOWLIST = [
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "SystemRoot", "windir", "PATHEXT", "ComSpec",
  "PROCESSOR_ARCHITECTURE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM",
];

function getDefaultEnvironment() {
  const env = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Resolve exact ${ENV_NAME} references without interpolating arbitrary text. */
export function interpolateEnv(values, serverName, label = "env var") {
  const resolved = {};
  for (const [key, rawValue] of Object.entries(values ?? {})) {
    const value = String(rawValue);
    const match = ENV_REF_RE.exec(value);
    if (!match) {
      resolved[key] = value;
      continue;
    }
    const variable = match[1];
    if (process.env[variable] === undefined) {
      throw new Error(`Server "${serverName}": ${label} "${key}" references \${${variable}}, which is not set in your shell.`);
    }
    resolved[key] = process.env[variable];
  }
  return resolved;
}

function resolveEnvironment(entry, serverName) {
  return {
    ...getDefaultEnvironment(),
    ...(entry.inheritEnv ? process.env : {}),
    ...interpolateEnv(entry.env, serverName),
  };
}

function samplingContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => block?.type === "text" ? block.text : JSON.stringify(block)).join("\n");
  }
  return content?.type === "text" ? content.text : JSON.stringify(content);
}

function installSamplingHandler(client) {
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const { messages: samplingMessages, systemPrompt } = request.params;
    const chatMessages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...samplingMessages.map((message) => ({
        role: message.role,
        content: samplingContentToText(message.content),
      })),
    ];
    const { routeChat } = await import("./router.js");
    const { message, model } = await routeChat(chatMessages, []);
    return {
      model,
      role: "assistant",
      stopReason: "endTurn",
      content: { type: "text", text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) },
    };
  });
}

function installRootsHandler(client, name, entry) {
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    const rootPath = path.resolve(entry.root ?? entry.cwd ?? process.cwd());
    return { roots: [{ uri: pathToFileURL(rootPath).href, name }] };
  });
}

function installToolChangeHandler(client) {
  const listeners = new Set();
  toolChangeListeners.set(client, listeners);
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    for (const listener of listeners) {
      try { await listener(); } catch { /* A UI listener must not break the protocol client. */ }
    }
  });
}

export function onToolsChanged(client, listener) {
  const listeners = toolChangeListeners.get(client);
  if (!listeners) return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function captureStderr(transport) {
  if (!transport?.stderr) return;
  let buffer = "";
  transport.stderr.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_STDERR_BYTES) {
      buffer = buffer.slice(-MAX_STDERR_BYTES);
    }
  });
  stderrBuffers.set(transport, () => buffer);
}

export function getLastStderr(transport) {
  return stderrBuffers.get(transport)?.() ?? "";
}

function connectionError(name, entry, error, transport) {
  const target = entry.url ? redactUrl(entry.url) : entry.command;
  const stderr = getLastStderr(transport).trim();
  const suffix = stderr ? `\nServer stderr:\n${stderr}` : "";
  return new Error(`Failed to connect to server "${name}" (${target}): ${error.message}${suffix}`, { cause: error });
}

async function raceWithTimeout(promise, ms, message, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      Promise.resolve(onTimeout?.())
        .catch(() => {})
        .finally(() => reject(new Error(message)));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function connectServer(name, entry, { timeoutMs } = {}) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`No configuration found for server "${name}".`);
  }

  const capabilities = { roots: { listChanged: true } };
  if (entry.allowSampling) capabilities.sampling = {};
  const client = new Client(
    { name: "mcp-dev-cli", version: "0.2.0" },
    { capabilities }
  );
  if (entry.allowSampling) installSamplingHandler(client);
  installRootsHandler(client, name, entry);
  installToolChangeHandler(client);

  let transport;
  try {
    if (entry.url) {
      const headers = interpolateEnv(entry.headers, name, "header");
      transport = new StreamableHTTPClientTransport(new URL(entry.url), {
        ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      });
    } else {
      const { command, args } = resolveWindowsCommand(entry.command, entry.args ?? []);
      transport = new StdioClientTransport({
        command,
        args,
        env: resolveEnvironment(entry, name),
        cwd: entry.cwd ?? undefined,
        stderr: "pipe",
      });
      captureStderr(transport);
    }

    await raceWithTimeout(
      client.connect(transport),
      timeoutMs,
      `connecting to "${name}" timed out after ${timeoutMs}ms`,
      () => client.close().catch(() => {})
    );
  } catch (error) {
    await client.close().catch(() => {});
    throw connectionError(name, entry, error, transport);
  }

  activeClients.add(client);
  return client;
}

const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

export function isTransientError(error) {
  if (error && TRANSIENT_ERROR_CODES.has(error.code)) return true;
  if (error && TRANSIENT_ERROR_CODES.has(error.cause?.code)) return true;
  return /socket hang up|network|fetch failed|connection.*closed|timed out/i.test(error?.message ?? "");
}

export async function connectServerWithRetry(name, entry, { retries = 2, baseDelayMs = 250, timeoutMs = 8_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await connectServer(name, entry, { timeoutMs });
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === retries) throw error;
      // Full jitter avoids several sessions retrying a remote service in lockstep.
      const maximumDelay = baseDelayMs * (2 ** attempt);
      const delay = Math.round(Math.random() * maximumDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/** One in-flight connection per session server prevents duplicate child processes. */
export async function getOrConnectServer(name, entry, options = {}) {
  const existing = sessionClients.get(name);
  if (existing) return existing;
  const connecting = connectingClients.get(name);
  if (connecting) return connecting;

  const pending = connectServerWithRetry(name, entry, options)
    .then((client) => {
      sessionClients.set(name, client);
      return client;
    })
    .finally(() => connectingClients.delete(name));
  connectingClients.set(name, pending);
  return pending;
}

export async function disconnectServer(name) {
  const pending = connectingClients.get(name);
  if (pending) {
    try { await pending; } catch { return false; }
  }
  const client = sessionClients.get(name);
  if (!client) return Boolean(pending);
  await client.close();
  activeClients.delete(client);
  toolChangeListeners.delete(client);
  sessionClients.delete(name);
  return true;
}

export function listConnected() {
  return [...sessionClients.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function listTools(client, options = {}) {
  const allTools = [];
  const seenCursors = new Set();
  let cursor;
  let pages = 0;

  do {
    if (++pages > MAX_TOOL_PAGES) throw new Error(`Server returned more than ${MAX_TOOL_PAGES} tool-list pages.`);
    if (cursor && seenCursors.has(cursor)) throw new Error("Server repeated a tool-list cursor; refusing an infinite pagination loop.");
    if (cursor) seenCursors.add(cursor);

    const response = await client.listTools(cursor ? { cursor } : undefined, options);
    if (!Array.isArray(response.tools)) throw new Error("Server returned an invalid tools/list response.");
    allTools.push(...response.tools);
    if (allTools.length > MAX_TOOLS) throw new Error(`Server reported more than ${MAX_TOOLS} tools; refusing an unbounded response.`);
    cursor = response.nextCursor;
  } while (cursor);

  allTools.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" }));
  return allTools;
}

export async function callTool(client, toolName, args, options = {}) {
  return client.callTool({ name: toolName, arguments: args }, undefined, options);
}

export async function callToolResilient(name, entry, toolName, args, options = {}) {
  const client = await getOrConnectServer(name, entry, options);
  try {
    return await callTool(client, toolName, args, options);
  } catch (error) {
    if (options.signal?.aborted || !isTransientError(error)) throw error;
    await disconnectServer(name);
    const fresh = await getOrConnectServer(name, entry, options);
    return callTool(fresh, toolName, args, options);
  }
}

/** Wrap an MCP operation in Ctrl+C cancellation while keeping other SIGINT handlers intact. */
export function withCancellation(action, { timeoutMs, timeoutMessage = "Operation" } = {}) {
  return async (...args) => {
    const controller = new AbortController();
    const onSigint = () => controller.abort(new Error("Cancelled by user (SIGINT)"));
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`${timeoutMessage} timed out after ${timeoutMs}ms`)), timeoutMs)
      : null;
    process.once("SIGINT", onSigint);
    try {
      return await action(controller.signal, ...args);
    } finally {
      if (timer) clearTimeout(timer);
      process.removeListener("SIGINT", onSigint);
    }
  };
}

export function withTimeout(promise, ms, message) {
  return raceWithTimeout(promise, ms, message);
}

export async function closeClient(client) {
  if (!client) return;
  await client.close();
  activeClients.delete(client);
  toolChangeListeners.delete(client);
  for (const [name, sessionClient] of sessionClients) {
    if (sessionClient === client) sessionClients.delete(name);
  }
}

export async function closeAllClients() {
  const pending = [...connectingClients.values()];
  connectingClients.clear();
  await Promise.allSettled(pending);
  await Promise.allSettled([...activeClients].map((client) => client.close()));
  activeClients.clear();
  sessionClients.clear();
}
