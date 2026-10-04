// src/spinner.js
//
// Progress indicator for tool calls and server connections. Long calls used to
// block with no feedback and no way to stop them; the spinner shows elapsed
// time and stays cancellable (Ctrl+C or Esc) while a call is in flight.

import { InlineFrame } from "./frame.js";
import { colors, marks } from "./colors.js";
import { stripAnsi, visibleWidth } from "./terminal.js";
import { TERMINAL_MODES } from "./keys.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 90;

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function createSpinner({ output = process.stdout } = {}) {
  const frame = new InlineFrame(output);
  let timer = null;
  let startedAt = 0;
  let label = "";
  let detail = "";
  let active = false;

  const render = () => {
    if (!active) return;
    const glyph = colors.accent(FRAMES[Math.floor((Date.now() - startedAt) / TICK_MS) % FRAMES.length]);
    const elapsed = colors.faint(formatElapsed(Date.now() - startedAt));
    const suffix = detail ? ` ${colors.warning(detail)}` : "";
    frame.render([`${glyph} ${label} ${elapsed}${suffix}`], null);
  };

  return {
    start(nextLabel) {
      label = nextLabel;
      detail = "";
      startedAt = Date.now();
      active = true;
      render();
      timer = setInterval(render, TICK_MS);
      timer.unref?.();
    },
    update(nextLabel, nextDetail = "") {
      label = nextLabel;
      detail = nextDetail;
      render();
    },
    /** Stop and print a permanent status line. */
    stop(text = "", { tone = "success" } = {}) {
      if (!active) {
        if (text) output.write(`${text}\n`);
        return;
      }
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      const elapsed = formatElapsed(Date.now() - startedAt);
      frame.erase();
      if (text) {
        const color = tone === "error" ? colors.error : tone === "warn" ? colors.warning : tone === "muted" ? colors.muted : colors.success;
        output.write(`${color(text)} ${colors.faint(elapsed)}\n`);
      }
    },
  };
}

/**
 * Run `task` under a spinner, optionally listening for Ctrl+C / Esc so the
 * operation can be cancelled without killing the session.
 *
 * @returns {Promise<{ok:boolean, value?:any, error?:Error, cancelled:boolean}>}
 */
export async function runWithSpinner(label, task, { listen = true, input = process.stdin, output = process.stdout, signal: externalSignal = null } = {}) {
  const spinner = createSpinner({ output });
  const controller = new AbortController();
  const cancellable = listen && input.isTTY && typeof input.setRawMode === "function";

  const onExternalAbort = () => controller.abort(externalSignal?.reason ?? new Error("Cancelled"));
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const onData = (chunk) => {
    // Keep whatever the user types while the call runs: it is replayed into the
    // next prompt. Ctrl+C cancels, a lone Escape cancels, arrow keys do not.
    const { cancel, rest } = splitCancelChunk(chunk.toString("utf8"));
    if (rest) pushBytes(rest);
    if (cancel) {
      spinner.update(label, "cancelling… (Ctrl+C)");
      controller.abort(new Error("Cancelled by user"));
    }
  };

  spinner.start(label);
  if (cancellable) {
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  }

  const started = Date.now();
  try {
    const value = await task({ signal: controller.signal });
    if (controller.signal.aborted) {
      spinner.stop(`${marks.warn()} ${stripAnsi(label)} cancelled`, { tone: "warn" });
      return { ok: false, cancelled: true, error: controller.signal.reason };
    }
    spinner.stop(`${marks.ok()} ${stripAnsi(label)}`, { tone: "success" });
    return { ok: true, value, cancelled: false, elapsedMs: Date.now() - started };
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop(`${marks.warn()} ${stripAnsi(label)} cancelled`, { tone: "warn" });
      return { ok: false, cancelled: true, error };
    }
    spinner.stop(`${marks.fail()} ${stripAnsi(label)} — ${error.message}`, { tone: "error" });
    return { ok: false, cancelled: false, error };
  } finally {
    externalSignal?.removeEventListener?.("abort", onExternalAbort);
    if (cancellable) {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write(TERMINAL_MODES.leave);
    }
  }
}

export { formatElapsed, visibleWidth };
