import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const explicitPath = process.env.MCP_DEV_CONFIG_PATH?.trim();
const explicitDir = process.env.MCP_DEV_CONFIG_DIR?.trim();
const defaultDir = path.join(os.homedir(), ".mcp-dev");

const CONFIG_PATH = explicitPath
  ? path.resolve(explicitPath)
  : path.join(path.resolve(explicitDir || defaultDir), "servers.json");
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const LOCK_PATH = `${CONFIG_PATH}.lock`;
const LOCK_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 30_000;

export const SERVER_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const ServerNameSchema = z.string().regex(
  SERVER_NAME_RE,
  "must be 1–64 characters of letters, digits, dot, underscore, or dash; it must start and end with a letter or digit"
);
const EnvRecordSchema = z.record(z.string(), z.string());
const DescriptionSchema = z.string().trim().min(1).max(240).optional();

const CommonServerFields = {
  root: z.string().min(1).optional(),
  description: DescriptionSchema,
  // Sampling can send server-provided content to a configured model provider.
  // It is deliberately opt-in per server.
  allowSampling: z.boolean().optional(),
};

const StdioServerSchema = z.object({
  command: z.string().trim().min(1, "command must be a non-empty string"),
  args: z.array(z.string()).default([]).optional(),
  cwd: z.string().min(1).optional(),
  env: EnvRecordSchema.optional(),
  inheritEnv: z.boolean().optional(),
  ...CommonServerFields,
}).strict();

const HttpServerSchema = z.object({
  url: z.url("url must be a valid absolute URL").refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "url must use http or https"),
  headers: EnvRecordSchema.optional(),
  ...CommonServerFields,
}).strict();

export const ServerEntrySchema = z.union([HttpServerSchema, StdioServerSchema]);
const ConfigSchema = z.object({
  servers: z.record(ServerNameSchema, ServerEntrySchema),
}).strict();

function formatZodError(error, context) {
  const lines = error.issues.map((issue) => {
    const issuePath = issue.path.length ? issue.path.join(".") : "(root)";
    return `  ${issuePath}: ${issue.message}`;
  });
  return `${context}:\n${lines.join("\n")}`;
}

function bestEffortChmod(file, mode) {
  try { fs.chmodSync(file, mode); } catch { /* Windows and some filesystems do not support POSIX modes. */ }
}

function ensureConfigDirectory() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  bestEffortChmod(CONFIG_DIR, 0o700);
}

function ensureConfig() {
  ensureConfigDirectory();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ servers: {} }, null, 2) + "\n", { mode: 0o600 });
  }
  bestEffortChmod(CONFIG_PATH, 0o600);
}

function sleepSync(ms) {
  // Atomics.wait sleeps without burning a CPU core while another short-lived
  // process owns the lock. Node 18+ supports this on the main thread.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function currentLockMetadata() {
  return JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: Date.now() });
}

function readLockMetadata() {
  try { return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")); } catch { return null; }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function clearStaleLock() {
  try {
    const stat = fs.statSync(LOCK_PATH);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
    const metadata = readLockMetadata();
    // Do not remove a potentially live lock from another machine on a shared
    // filesystem. Local orphaned locks can be recovered safely.
    if (metadata?.hostname && metadata.hostname !== os.hostname()) return false;
    if (metadata?.pid && processExists(metadata.pid)) return false;
    fs.unlinkSync(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(timeoutMs = LOCK_TIMEOUT_MS) {
  ensureConfigDirectory();
  const started = Date.now();
  while (true) {
    try {
      fs.writeFileSync(LOCK_PATH, currentLockMetadata(), { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      clearStaleLock();
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for configuration lock at ${LOCK_PATH}. Another mcp-dev command may still be writing.`);
      }
      sleepSync(25);
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* Lock was already removed. */ }
}

function withLock(action) {
  acquireLock();
  try {
    return action();
  } finally {
    releaseLock();
  }
}

export function loadConfig() {
  ensureConfig();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${error.message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) throw new Error(formatZodError(result.error, `${CONFIG_PATH} failed validation`));
  return result.data;
}

function saveConfigUnlocked(config) {
  ensureConfig();
  const result = ConfigSchema.safeParse(config);
  if (!result.success) throw new Error(formatZodError(result.error, "Refusing to write invalid configuration"));

  const tempPath = `${CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(result.data, null, 2) + "\n", { mode: 0o600 });
    bestEffortChmod(tempPath, 0o600);
    fs.renameSync(tempPath, CONFIG_PATH);
    bestEffortChmod(CONFIG_PATH, 0o600);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* cleanup only */ }
  }
}

export function saveConfig(config) {
  return withLock(() => saveConfigUnlocked(config));
}

export function assertServerName(name) {
  const result = ServerNameSchema.safeParse(name);
  if (!result.success) throw new Error(formatZodError(result.error, `Invalid server name "${name}"`));
  return result.data;
}

export function addServer(name, entry) {
  const validName = assertServerName(name);
  const parsedEntry = ServerEntrySchema.safeParse(entry);
  if (!parsedEntry.success) throw new Error(formatZodError(parsedEntry.error, `Invalid entry for server "${validName}"`));

  return withLock(() => {
    const config = loadConfig();
    config.servers[validName] = parsedEntry.data;
    saveConfigUnlocked(config);
  });
}

export function removeServer(name) {
  return withLock(() => {
    const config = loadConfig();
    if (!(name in config.servers)) return false;
    delete config.servers[name];
    saveConfigUnlocked(config);
    return true;
  });
}

export function getServer(name) {
  return loadConfig().servers[name];
}

export function listServers() {
  const servers = loadConfig().servers;
  return Object.fromEntries(Object.entries(servers).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
}

export const CONFIG_PATH_EXPORT = CONFIG_PATH;
export const CONFIG_DIR_EXPORT = CONFIG_DIR;
export const LOCK_PATH_EXPORT = LOCK_PATH;
