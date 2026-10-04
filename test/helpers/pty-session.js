// test/helpers/pty-session.js
//
// Drive `mcp-dev session` through a real pseudo-terminal and assert on both the
// byte stream and an emulated screen. The session UI owns raw mode, its own key
// decoder, and a full-screen renderer, so "the caret jumped to the wrong row" or
// "a repaint ate the previous result" can only be reproduced with a real pty and
// a grid (./vterm.js) to inspect.
//
// Steps run strictly in order: wait for `wait`/`waitScreen` to match, then send
// `send`. Fixed delays are flaky (a lazy connect takes a few hundred
// milliseconds); waiting for the UI to reach each state is not.
//
// A repaint can arrive in several pty chunks, so a step only commits once the
// stream has been quiet for SETTLE_MS. Without that pause a `waitScreen` could
// match a half-drawn frame — the text would be on the grid but the caret move
// would still be in flight, and the next key would be sent into a paint.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VTerm, stripAnsi } from "./vterm.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENTRY = path.join(root, "src", "index.js");
export const FIXTURE = path.join(root, "test", "fixtures", "echo-server.mjs");
export const ROOT = root;

/** Quiet time that ends a repaint before a step is snapshotted and committed. */
const SETTLE_MS = 30;

export const hasScript = (() => {
  if (process.env.MCP_DEV_SKIP_PTY) return false;
  try {
    return spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

/** Isolated config dir; defaults to the echo fixture registered as "demo". */
export function makeConfigDir(servers = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-pty-"));
  const registered = servers ?? {
    demo: { command: process.execPath, args: [FIXTURE], cwd: root, description: "pty fixture" },
  };
  fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ servers: registered }, null, 2));
  return dir;
}

/**
 * @param {Array<{wait?: RegExp, waitScreen?: RegExp|((term: import("./vterm.js").VTerm, screen: string) => boolean), send?: string|null, name?: string}>} script
 * @param {{env?: object, rows?: number, cols?: number, timeoutMs?: number, onStep?: Function}} [options]
 */
export function driveSession(script, { env = {}, rows = 30, cols = 100, timeoutMs = 45_000, onStep = null } = {}) {
  return new Promise((resolve, reject) => {
    // `script` inherits the caller's terminal size — which is 0x0 when the test
    // itself runs without a tty — so pin the pty size to the emulator's grid.
    const command = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} session`;
    const child = spawn("script", ["-qec", command, "/dev/null"], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows), ...env },
    });

    const term = new VTerm({ rows, cols });
    const snapshots = [];
    let raw = "";
    let visible = "";
    let mark = 0;
    let index = 0;
    let finished = false;
    let settleTimer = null;
    let ready = null; // the step that matched, waiting for the stream to settle
    const sent = [];

    const fail = (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      child.kill("SIGKILL");
      const screen = term.text().split("\n").map((line, i) => `${String(i).padStart(2)}| ${line}`).join("\n");
      reject(new Error(`${message}\n--- screen (cursor ${term.row},${term.col}) ---\n${screen}\n--- tail ---\n${visible.slice(-1200)}`));
    };

    const timer = setTimeout(() => {
      const pending = script[index];
      fail(`session did not reach step ${index} (${pending?.name ?? pending?.wait ?? pending?.waitScreen}) within ${timeoutMs}ms`);
    }, timeoutMs);

    const matches = (step) => {
      if (step.waitScreen) {
        const screen = term.text();
        if (typeof step.waitScreen === "function") return Boolean(step.waitScreen(term, screen));
        return step.waitScreen.test(screen);
      }
      if (step.wait instanceof RegExp) return step.wait.test(stripAnsi(raw.slice(mark)));
      return true;
    };

    let closeTimer = null;
    const wantsOut = () => finished || stripAnsi(raw).includes("session closed") || child.exitCode !== null || child.signalCode !== null;
    const scheduleClose = () => {
      if (closeTimer || finished) return;
      // Only nudge a session that is genuinely still running and has not
      // already said goodbye; a late write to an exiting child can land in a
      // cooked-mode window and SIGINT it.
      const nudge = (attempt) => {
        if (finished || wantsOut()) return;
        if (attempt === 0) child.stdin.write("\u001b");       // leave any open dialog
        child.stdin.write("\u0003");                            // cancel the line
        setTimeout(() => {
          if (finished || wantsOut()) return;
          child.stdin.write("\u0003");                          // and leave
          setTimeout(() => nudge(attempt + 1), 400);             // a cancel may have eaten one press
        }, 120);
      };
      closeTimer = setTimeout(() => nudge(0), 3000);
    };

    /** Snapshot the settled frame, send the step's keys, and look for the next. */
    const commit = (step, at) => {
      ready = null;
      if (finished) return;
      // Re-check: the frame may have moved on while we waited for quiet.
      if (at && !matches(step)) {
        pump();
        return;
      }
      index += 1;
      mark = raw.length;
      snapshots.push({
        name: step.name ?? String(step.wait ?? step.waitScreen ?? index),
        screen: term.text(),
        cursor: { row: term.row, col: term.col },
        text: stripAnsi(raw),
      });
      if (step.send != null) {
        sent.push(step.send);
        child.stdin.write(step.send);
      }
      onStep?.(step, term);
      // Schedule the fallback shutdown as soon as nothing but waits remain,
      // even if the session goes quiet and stops emitting data (the pump
      // below would never run again otherwise).
      if (!script.slice(index).some((later) => later.send != null)) scheduleClose();
      pump();
    };

    const pump = () => {
      if (finished) return;
      if (settleTimer) return; // a step is already waiting for the stream to end
      while (index < script.length) {
        const step = script[index];
        if (!matches(step)) break;
        // Let the rest of this frame arrive (a repaint can be split across
        // reads) before treating the screen as settled.
        ready = step;
        settleTimer = setTimeout(() => {
          settleTimer = null;
          const step = ready;
          if (step) commit(step, true);
        }, SETTLE_MS);
        return;
      }
      if (finished) return;
      if (!script.slice(index).some((step) => step.send != null)) scheduleClose();
    };

    const onChunk = (chunk) => {
      const text = chunk.toString("utf8");
      raw += text;
      visible += stripAnsi(text);
      term.write(text);
      if (settleTimer) {
        // More of the frame landed: restart the quiet window.
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          const step = ready;
          if (step) commit(step, true);
        }, SETTLE_MS);
        return;
      }
      pump();
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("exit", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve({ code, output: raw, visible: stripAnsi(raw), sent, term, snapshots });
    });
    child.on("error", (error) => fail(`spawn failed: ${error.message}`));
  });
}

export { stripAnsi };
