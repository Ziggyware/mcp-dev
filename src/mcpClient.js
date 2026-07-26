import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CreateMessageRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { routeChat } from "./router.js";

const activeClients = new Set();
const sessionClients = new Map();

function winCliQuote(arg) {
  let result = String(arg).replace(/(\\*)"/g, '$1$1\\"');
  result = result.replace(/(\\+)$/, "$1$1");
  return `"${result}"`;
}

function cmdMetaEscape(quotedArg) {
  return quotedArg.replace(/[()%!^<>&|;,]/g, "^$&");
}

function buildWindowsCommandLine(command, args) {
  return [command, ...args].map((a) => cmdMetaEscape(winCliQuote(a))).join(" ");
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
];

function getDefaultEnvironment() {
  const env = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function interpolateEnv(env, serverName) {
  const resolved = {};
  for (const [key, rawValue] of Object.entries(env ?? {})) {
    const m = ENV_REF_RE.exec(rawValue);
    if (!m) { resolved[key] = rawValue; continue; }
    const varName = m[1];
    if (process.env[varName] === undefined) {
      throw new Error(`Server "${serverName}": env var "${key}" references \${${varName}}, which is not set in your shell.`);
    }
    resolved[key] = process.env[varName];
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

function installSamplingHandler(client) {
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const { messages: samplingMessages, systemPrompt, maxTokens } = request.params;

    const chatMessages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...samplingMessages.map((m) => ({
        role: m.role,
        content: m.content.type === "text" ? m.content.text : JSON.stringify(m.content),
      })),
    ];

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

export async function connectServer(name, entry) {
  const client = new Client(
    { name: "mcp-dev-cli", version: "0.1.0" },
    { capabilities: { sampling: {}, roots: { listChanged: true } } }
  );

  installSamplingHandler(client);
  installRootsHandler(client, name, entry);

  let transport;
  if (entry.url) {
    transport = new StreamableHTTPClientTransport(new URL(entry.url));
  } else {
    const { command, args } = resolveWindowsCommand(entry.command, entry.args ?? []);
    transport = new StdioClientTransport({
      command,
      args,
      env: resolveEnvironment(entry, name),
      cwd: entry.cwd ?? undefined,
      stderr: "pipe",
    });
  }

  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(`Failed to connect to server "${name}" (${entry.url ?? entry.command}): ${err.message}`);
  }

  activeClients.add(client);
  return client;
}

const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]);

export function isTransientError(err) {
  if (err && TRANSIENT_ERROR_CODES.has(err.code)) return true;
  if (err && TRANSIENT_ERROR_CODES.has(err.cause?.code)) return true;
  return /socket hang up|network|fetch failed/i.test(err?.message ?? "");
}

export async function connectServerWithRetry(name, entry, { retries = 3, baseDelayMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await connectServer(name, entry);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === retries) throw err;
      const backoff = baseDelayMs * 2 ** attempt;
      const jittered = backoff * (0.5 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, jittered));
    }
  }
  throw lastErr;
}

export async function getOrConnectServer(name, entry) {
  if (sessionClients.has(name)) return sessionClients.get(name);
  const client = await connectServerWithRetry(name, entry);
  sessionClients.set(name, client);
  return client;
}

export async function disconnectServer(name) {
  const client = sessionClients.get(name);
  if (!client) return false;
  await client.close();
  activeClients.delete(client);
  sessionClients.delete(name);
  return true;
}

export function listConnected() {
  return [...sessionClients.keys()];
}

export async function listTools(client) {
  const allTools = [];
  let cursor;
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    allTools.push(...res.tools);
    cursor = res.nextCursor;
  } while (cursor);

  // Server-declared order across paginated listTools() calls isn't
  // guaranteed stable — depends entirely on server-side iteration order
  // (reflection order, dictionary order, whatever the server backend uses).
  // Sort once here so every consumer (palette search, `tools` command,
  // session tool cache) sees deterministic alphabetical order without each
  // needing its own sort.
  allTools.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  return allTools;
}

export async function callTool(client, toolName, args, options = {}) {
  return client.callTool({ name: toolName, arguments: args }, undefined, options);
}

export async function callToolResilient(name, entry, toolName, args, options = {}) {
  const client = await getOrConnectServer(name, entry);
  try {
    return await callTool(client, toolName, args, options);
  } catch (err) {
    if (options.signal?.aborted || !isTransientError(err)) throw err;
    await disconnectServer(name);
    const fresh = await connectServerWithRetry(name, entry);
    sessionClients.set(name, fresh);
    activeClients.add(fresh);
    return await callTool(fresh, toolName, args, options);
  }
}

export function withCancellation(fn) {
  return async (...args) => {
    const controller = new AbortController();
    const onSigint = () => controller.abort(new Error("Cancelled by user (SIGINT)"));
    process.once("SIGINT", onSigint);
    try {
      return await fn(controller.signal, ...args);
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  };
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function closeClient(client) {
  await client.close();
  activeClients.delete(client);
}

export async function closeAllClients() {
  await Promise.allSettled([...activeClients].map((c) => c.close()));
  activeClients.clear();
  sessionClients.clear();
}

// Improvement 7: stderr capture surfaced on connect failure. StdioClientTransport
// is spawned with stderr: "pipe" (already the case) but nothing previously
// read that stream -- a server crashing on startup produced only "connect
// ECONNRESET"-style transport errors with the server's own diagnostic
// output (its actual crash reason) silently discarded. This attaches a
// bounded ring buffer to each stdio transport's stderr and exposes it via
// getLastStderr, called from index.js/session.js error paths.
const stderrBuffers = new WeakMap();
const MAX_STDERR_BYTES = 4096;

export function captureStderr(transport) {
  if (!transport?.stderr) return;
  let buf = "";
  transport.stderr.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (buf.length > MAX_STDERR_BYTES) buf = buf.slice(buf.length - MAX_STDERR_BYTES);
  });
  stderrBuffers.set(transport, () => buf);
}

export function getLastStderr(transport) {
  const getter = stderrBuffers.get(transport);
  return getter ? getter() : "";
}