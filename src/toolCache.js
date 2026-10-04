import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_EXPORT } from "./config.js";

export const TOOL_CACHE_PATH = path.join(CONFIG_DIR_EXPORT, "tools.json");
const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;
export const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function fingerprintServer(entry) {
  const identity = {
    url: entry?.url,
    headers: entry?.headers,
    command: entry?.command,
    args: entry?.args,
    cwd: entry?.cwd,
    root: entry?.root,
    env: entry?.env,
    inheritEnv: entry?.inheritEnv,
    allowSampling: entry?.allowSampling,
  };
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(identity))).digest("hex");
}

function emptyCache() {
  return { version: CACHE_VERSION, servers: {} };
}

function validCache(value) {
  return value
    && value.version === CACHE_VERSION
    && value.servers
    && typeof value.servers === "object"
    && !Array.isArray(value.servers);
}

export function readToolCache() {
  try {
    const raw = fs.readFileSync(TOOL_CACHE_PATH, "utf8");
    if (Buffer.byteLength(raw) > MAX_CACHE_BYTES) return emptyCache();
    const parsed = JSON.parse(raw);
    return validCache(parsed) ? parsed : emptyCache();
  } catch (error) {
    if (error?.code !== "ENOENT") return emptyCache();
    return emptyCache();
  }
}

function ensureDirectory() {
  fs.mkdirSync(CONFIG_DIR_EXPORT, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR_EXPORT, 0o700); } catch { /* platform does not support POSIX modes */ }
}

function writeCache(cache) {
  const body = JSON.stringify(cache, null, 2);
  if (Buffer.byteLength(body) > MAX_CACHE_BYTES) return false;
  ensureDirectory();
  const tmp = `${TOOL_CACHE_PATH}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
    fs.renameSync(tmp, TOOL_CACHE_PATH);
    return true;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

/** Store only valid, bounded metadata. Cache failures must never block a tool call. */
export function cacheTools(name, entry, tools, now = Date.now()) {
  if (!Array.isArray(tools)) return false;
  const record = {
    fingerprint: fingerprintServer(entry),
    fetchedAt: now,
    tools,
  };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_ENTRY_BYTES) return false;

  try {
    const cache = readToolCache();
    cache.servers[name] = record;
    return writeCache(cache);
  } catch {
    return false;
  }
}

export function getCachedTools(name, entry, { maxAgeMs = DEFAULT_CACHE_TTL_MS, allowStale = false, now = Date.now() } = {}) {
  const record = readToolCache().servers[name];
  if (!record || record.fingerprint !== fingerprintServer(entry) || !Array.isArray(record.tools)) return null;
  const ageMs = Math.max(0, now - Number(record.fetchedAt || 0));
  if (!allowStale && ageMs > maxAgeMs) return null;
  return { tools: record.tools, ageMs, stale: ageMs > maxAgeMs };
}

export function invalidateToolCache(name) {
  try {
    const cache = readToolCache();
    if (!(name in cache.servers)) return false;
    delete cache.servers[name];
    return writeCache(cache);
  } catch {
    return false;
  }
}

export function clearToolCache() {
  try {
    fs.unlinkSync(TOOL_CACHE_PATH);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
