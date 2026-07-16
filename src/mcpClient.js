import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const activeClients = new Set();
// Session-only: maps server name -> live client, so a REPL session can reuse
// a connection across multiple commands instead of reconnecting each time.
// One-shot CLI commands (tools/call/ask) don't touch this map.
const sessionClients = new Map();

function resolveWindowsCommand(command, args) {
  if (process.platform !== "win32") return { command, args };
  const hasPathSeparator = /[\\/]/.test(command);
  const hasExplicitExt = /\.(exe|cmd|bat|com)$/i.test(command);
  if (hasPathSeparator || hasExplicitExt) return { command, args };
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  return { command: comspec, args: ["/d", "/s", "/c", command, ...args] };
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

function resolveEnvironment(entry) {
  return {
    ...getDefaultEnvironment(),
    ...(entry.inheritEnv ? process.env : {}),
    ...(entry.env ?? {}),
  };
}

export async function connectServer(name, entry) {
  const client = new Client({ name: "mcp-agent-cli", version: "0.1.0" }, { capabilities: {} });

  let transport;
  if (entry.url) {
    transport = new StreamableHTTPClientTransport(new URL(entry.url));
  } else {
    const { command, args } = resolveWindowsCommand(entry.command, entry.args ?? []);
    transport = new StdioClientTransport({
      command,
      args,
      env: resolveEnvironment(entry),
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

// Connects on first call, returns the cached live client on every subsequent
// call for the same name. This is what makes repeated commands inside a
// session reuse one connection instead of respawning the server each time.
export async function getOrConnectServer(name, entry) {
  if (sessionClients.has(name)) return sessionClients.get(name);
  const client = await connectServer(name, entry);
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
  const res = await client.listTools();
  return res.tools;
}

export async function callTool(client, toolName, args) {
  return client.callTool({ name: toolName, arguments: args });
}

export async function closeAllClients() {
  await Promise.allSettled([...activeClients].map((c) => c.close()));
  activeClients.clear();
  sessionClients.clear();
}