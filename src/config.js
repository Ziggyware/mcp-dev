import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".mcp-dev");
const CONFIG_PATH = path.join(CONFIG_DIR, "servers.json");

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify({ servers: {} }, null, 2));
}

export function loadConfig() {
  ensureConfig();
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(cfg) {
  ensureConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// entry shape: { command, args, env, cwd } for stdio servers, or { url } for HTTP/SSE servers
export function addServer(name, entry) {
  const cfg = loadConfig();
  cfg.servers[name] = entry;
  saveConfig(cfg);
}

export function removeServer(name) {
  const cfg = loadConfig();
  delete cfg.servers[name];
  saveConfig(cfg);
}

export function getServer(name) {
  const cfg = loadConfig();
  return cfg.servers[name];
}

export function listServers() {
  return loadConfig().servers;
}

export const CONFIG_PATH_EXPORT = CONFIG_PATH;
