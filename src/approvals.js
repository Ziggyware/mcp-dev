// src/approvals.js
//
// Session-scoped approval memory. The CLI stays approval-first, but repeating
// the identical confirmation for every call in a session is noise. Grants are
// explicit, scoped (tool / server / everything), displayed in the UI, and
// revoked with `/untrust`.

// `\b` is wrong here: underscores are word characters, so "write_file" would
// not match "write". Explicit separators keep tool names like write_file,
// delete_rows, and run_command flagged while leaving read_file alone.
const RISKY = /(^|[^a-z])(delete|remove|rm|write|edit|create|move|rename|kill|drop|truncate|format|uninstall|install|exec|run|shell|command|publish|deploy|push|merge|reset|chmod|chown|patch|update)([^a-z]|$)/i;

export function isRiskyTool(name) {
  return RISKY.test(String(name ?? ""));
}

export function riskyArgKeys(args = {}) {
  return Object.keys(args).filter((key) => /(path|file|target|output|destination|command|script|code|content|body)/i.test(key));
}

export class ApprovalStore {
  constructor() {
    this.toolGrants = new Set();
    this.serverGrants = new Set();
    this.allowAll = false;
  }

  static toolKey(server, tool) {
    return `${server}/${tool}`;
  }

  isGranted(server, tool) {
    if (this.allowAll) return true;
    if (this.serverGrants.has(server)) return true;
    return this.toolGrants.has(ApprovalStore.toolKey(server, tool));
  }

  grantTool(server, tool) {
    this.toolGrants.add(ApprovalStore.toolKey(server, tool));
  }

  grantServer(server) {
    this.serverGrants.add(server);
  }

  grantAll() {
    this.allowAll = true;
  }

  revoke(scope) {
    const target = String(scope ?? "").trim();
    if (!target || target === "all") {
      const cleared = this.list().length;
      this.toolGrants.clear();
      this.serverGrants.clear();
      this.allowAll = false;
      return cleared;
    }
    if (target.startsWith("server:")) {
      const name = target.slice(7);
      return this.serverGrants.delete(name) ? 1 : 0;
    }
    const removedTool = this.toolGrants.delete(target) ? 1 : 0;
    const removedServer = this.serverGrants.delete(target) ? 1 : 0;
    return removedTool + removedServer;
  }

  list() {
    const entries = [];
    if (this.allowAll) entries.push({ scope: "*", label: "every tool in this session" });
    for (const server of [...this.serverGrants].sort()) entries.push({ scope: `server:${server}`, label: `every tool on "${server}"` });
    for (const key of [...this.toolGrants].sort()) entries.push({ scope: key, label: key });
    return entries;
  }

  get size() {
    return this.list().length;
  }
}
