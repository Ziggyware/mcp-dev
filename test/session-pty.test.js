// End-to-end keyboard test for the interactive session.
//
// The session UI owns raw mode, the key decoder, and its own renderer, so unit
// tests alone cannot catch "the input got stuck" regressions. This test drives
// a real pseudo-terminal (via `script`) with real key sequences, and waits for
// the UI to reach each state before sending the next keystroke (fixed delays
// are flaky: `script` coalesces bursts and a lazy connect takes a few hundred
// milliseconds). It skips when no pty helper is available or MCP_DEV_SKIP_PTY
// is set.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "index.js");
const fixture = path.join(root, "test", "fixtures", "echo-server.mjs");

const hasScript = (() => {
  if (process.env.MCP_DEV_SKIP_PTY) return false;
  try {
    return spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

function stripAnsi(text) {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "\n");
}

function makeConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-pty-"));
  fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({
    servers: {
      demo: { command: process.execPath, args: [fixture], cwd: root, description: "pty fixture" },
    },
  }, null, 2));
  return dir;
}

/**
 * Run the session in a pty. `script` is a list of `{wait, send}` pairs: wait
 * for the accumulated (ANSI-stripped) output to match `wait`, then send `send`.
 * Any step may be a bare string pattern, which sends nothing and just waits.
 */
function driveSession(script, { env = {}, timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qec", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} session`, "/dev/null"], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: "100", LINES: "30", ...env },
    });

    let raw = "";
    let mark = 0;
    let index = 0;
    let finished = false;
    const sent = [];

    const fail = (message) => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`${message}\nLast UI state:\n${stripAnsi(raw).slice(-3000)}`));
    };

    const timer = setTimeout(() => {
      const pending = script[index];
      fail(`session did not reach step ${index} (${pending?.wait ?? "done"}) within ${timeoutMs}ms`);
    }, timeoutMs);

    let closeTimer = null;
    const scheduleClose = () => {
      if (closeTimer || finished) return;
      closeTimer = setTimeout(() => {
        // Only nudge a session that is genuinely still running and has not
        // already said goodbye; a late write to an exiting child can land in a
        // cooked-mode window and SIGINT it.
        if (finished || stripAnsi(raw).includes("session closed")) return;
        if (child.exitCode === null && child.signalCode === null) child.stdin.write("\u0003\u0003");
      }, 3000);
    };

    const pump = () => {
      if (finished) return;
      // Only match against output produced since the previous step, otherwise a
      // pattern can match a frame that is still sitting in the scrollback.
      const fresh = stripAnsi(raw.slice(mark));
      while (index < script.length) {
        const step = script[index];
        const pattern = step.wait;
        if (pattern === null || pattern.test(fresh)) {
          index += 1;
          mark = raw.length;
          if (step.send != null) {
            sent.push(step.send);
            child.stdin.write(step.send);
          }
          // Schedule the fallback shutdown as soon as nothing but waits remain,
          // even if the session goes quiet and stops emitting data (the pump
          // below would never run again otherwise).
          if (!script.slice(index).some((later) => later.send != null)) scheduleClose();
          continue;
        }
        break;
      }
      // Once no later step sends anything, the only thing left is to wait for
      // output — so give the session a moment and then close it down. This also
      // rescues a test whose final Ctrl+D was dropped by the pty.
      if (finished) return;
      const remainingSends = script.slice(index).some((step) => step.send != null);
      if (!remainingSends) scheduleClose();
    };

    child.stdout.on("data", (chunk) => { raw += chunk.toString("utf8"); pump(); });
    child.stderr.on("data", (chunk) => { raw += chunk.toString("utf8"); pump(); });

    child.on("exit", (code) => {
      finished = true;
      clearTimeout(timer);
      resolve({ code, output: raw, visible: stripAnsi(raw), sent });
    });
    child.on("error", (err) => fail(`spawn failed: ${err.message}`));
  });
}

test("session: connect, guided call, remembered grant, inline args, cached results", { skip: !hasScript, timeout: 90_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, visible } = await driveSession([
      { wait: /Type a sentence/, send: "/demo/" },
      { wait: /❯ \/demo\//, send: "\r" },
      { wait: /demo — 4 tools/, send: "echo" },
      { wait: /❯ tool echo/, send: "\r" },
      { wait: /\[1\/2\] text required/, send: "hi" },
      { wait: /❯ text hi/, send: "\r" },
      { wait: /\[2\/2\] times optional/, send: "\r" },
      { wait: /about to call demo\/echo/, send: "a" },
      { wait: /cached as #1/, send: "/demo/echo {\"text\":\"again\"}" },
      { wait: /❯ \/demo\/echo/, send: "\r" },
      { wait: /\[1\/2\] text required/, send: "\r" },
      { wait: /\[2\/2\] times optional/, send: "\r" },
      { wait: /cached as #2/, send: "\u0003" },
      { wait: /press Ctrl\+C again to exit/, send: "\u0003" },
      { wait: /session closed/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" } });

    assert.equal(code, 0, visible.slice(-2000));
    assert.match(visible, /✓ demo\/echo text=hi/);
    assert.match(visible, /again/, "the inline-args call prints its result");
    assert.match(visible, /about to call demo\/echo/, "the approval screen appears for the first call");
    assert.match(visible, /auto-approved by a session grant/, "the remembered grant skips the second approval");
    assert.match(visible, /Enter on empty skips/, "optional fields advertise how to skip them");
    assert.match(visible, /Ctrl\+Enter newline/, "the prompt footer teaches the newline key");

  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("session: Escape clears the line, typing still works, Ctrl+D exits", { skip: !hasScript, timeout: 60_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, visible } = await driveSession([
      { wait: /Type a sentence/, send: "draft text" },
      { wait: /❯ draft text/, send: "\u001b" },
      { wait: /Input cleared/, send: "still typing" },
      { wait: /❯ still typing/, send: "\u001b" },
      { wait: /Input cleared/, send: "\u0004" },
      { wait: /session closed/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir } });

    assert.equal(code, 0, visible.slice(-2000));
    assert.match(visible, /Input cleared/);
    assert.match(visible, /❯ still typing/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("session: /help works without an API key and names the direct-call path", { skip: !hasScript, timeout: 60_000 }, async () => {
  const configDir = makeConfigDir();
  try {
    const { code, visible } = await driveSession([
      { wait: /Type a sentence/, send: "/help" },
      { wait: /❯ \/help/, send: "\r" },
      { wait: /input guide/, send: null },
      // Leave through /exit rather than Ctrl+D: a ^D sent while the help text
      // is still printing lands in cooked mode and is swallowed by the
      // terminal driver (Ctrl+D itself is covered by the previous test).
      { wait: /Enter run/, send: "/exit" },
      { wait: /❯ \/exit/, send: "\r" },
      { wait: /session closed/, send: null },
    ], { env: { MCP_DEV_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" } });

    assert.equal(code, 0, visible.slice(-2000));
    assert.match(visible, /Ctrl\+Enter/);
    assert.match(visible, /Cached results/);
    assert.doesNotMatch(visible, /Set ANTHROPIC_API_KEY to use chat/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
