import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

const CONFIG_DIR = path.join(os.homedir(), ".mcp-dev");
const CONFIG_PATH = path.join(CONFIG_DIR, "servers.json");
const LOCK_PATH = CONFIG_PATH + ".lock";

// Improvement 1: advisory file lock around read-modify-write config
// operations. Two concurrent `mcp-dev register` invocations (e.g. two
// terminal tabs) previously raced: both loadConfig(), both mutate their
// in-memory copy, both saveConfig() -- second writer wins, first writer's
// change is silently lost. This uses exclusive-create (`wx`) on a lock file
// as the mutex; a failed create means someone else holds it, so we spin
// with backoff until it's free or we time out.
function acquireLock(timeoutMs = 3000) {
  const start = Date.now();
  while (true) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for config lock at ${LOCK_PATH} (held by another mcp-dev process?)`);
      }
      const until = Date.now() + 25;
      while (Date.now() < until) { /* busy-wait: no async available in sync CLI path */ }
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
}

function withLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

const EnvRecordSchema = z.record(z.string(), z.string());

const StdioServerSchema = z
  .object({
    command: z.string().min(1, "command must be a non-empty string"),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    root: z.string().optional(),
    env: EnvRecordSchema.optional(),
    inheritEnv: z.boolean().optional(),
  })
  .strict();

const HttpServerSchema = z
  .object({
    url: z.url("url must be a valid absolute URL"),
    root: z.string().optional(),
  })
  .strict();

const ServerEntrySchema = z.union([HttpServerSchema, StdioServerSchema]);

const ConfigSchema = z.object({
  servers: z.record(z.string(), ServerEntrySchema),
});

function formatZodError(err, context) {
  const lines = err.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `  ${path}: ${issue.message}`;
  });
  return `${context}:\n${lines.join("\n")}`;
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify({ servers: {} }, null, 2));
}

export function loadConfig() {
  ensureConfig();
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(result.error, `${CONFIG_PATH} failed validation`));
  }
  return result.data;
}

// Improvement 1 (cont.): raw save, no lock -- only called from inside
// withLock-guarded callers below, so the lock is held for the whole
// read-modify-write span, not just this final write.
function saveConfigUnlocked(cfg) {
  ensureConfig();
  const result = ConfigSchema.safeParse(cfg);
  if (!result.success) {
    throw new Error(formatZodError(result.error, "Refusing to write invalid config"));
  }
  // Improvement 2: atomic write via temp-file + rename. A crash or
  // concurrent read mid-write previously risked observing a truncated
  // servers.json; rename() on POSIX and Windows (same volume) is atomic,
  // so readers only ever see the old complete file or the new complete
  // file, never a partial one.
  const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(result.data, null, 2));
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function saveConfig(cfg) {
  withLock(() => saveConfigUnlocked(cfg));
}

export function addServer(name, entry) {
  const entryResult = ServerEntrySchema.safeParse(entry);
  if (!entryResult.success) {
    throw new Error(formatZodError(entryResult.error, `Invalid entry for server "${name}"`));
  }
  withLock(() => {
    const cfg = loadConfig();
    cfg.servers[name] = entryResult.data;
    saveConfigUnlocked(cfg);
  });
}

export function removeServer(name) {
  withLock(() => {
    const cfg = loadConfig();
    delete cfg.servers[name];
    saveConfigUnlocked(cfg);
  });
}

export function getServer(name) {
  const cfg = loadConfig();
  return cfg.servers[name];
}

export function listServers() {
  return loadConfig().servers;
}

export const CONFIG_PATH_EXPORT = CONFIG_PATH;