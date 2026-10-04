// src/spinner.js
//
// Progress indicator for tool calls and server connections. Long calls used to
// block with no feedback and no way to stop them; the spinner shows elapsed
// time and stays cancellable (Ctrl+C or Esc) while a call is in flight.
//
// Inside a session the spinner is a single activity cell on the screen's status
// bar, so it can never scroll the transcript or tear the input block. Outside a
// session (one-shot `mcp-dev call`) it keeps painting an inline frame.

import { InlineFrame } from "./frame.js";
import { Screen } from "./screen.js";
import { pushBytes, splitCancelChunk } from "./typeahead.js";
import { createKeyDecoder, TERMINAL_MODES } from "./keys.js";
import { colors, marks } from "./colors.js";
import { stripAnsi, visibleWidth } from "./terminal.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 90;

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

function toneColor(tone) {
  return tone === "error" ? colors.error : tone === "warn" ? colors.warning : tone === "muted" ? colors.muted : colors.success;
}

export function createSpinner({ output = process.stdout, screen = null, label = "" } = {}) {
  const target = screen ?? Screen.current;
  const frame = target ? null : new InlineFrame(output);
  const startedAtRef = { value: 0 };
  let timer = null;
  let currentLabel = label;
  let detail = "";
  let active = false;
  const startedAt = () => startedAtRef.value;

  const render = () => {
    if (!active) return;
    const glyph = FRAMES[Math.floor((Date.now() - startedAt()) / TICK_MS) % FRAMES.length];
    const suffix = detail ? ` ${detail}` : "";
    if (target) {
      target.setActivity(`${colors.accent(glyph)} ${currentLabel}${suffix ? ` ${colors.warning(suffix.trim())}` : ""}`, { startedAt: startedAt() });
      target.render();
      return;
    }
    frame.render([`${colors.accent(glyph)} ${currentLabel} ${colors.faint(formatElapsed(Date.now() - startedAt()))}${suffix}`], null);
  };

  return {
    start(nextLabel) {
      currentLabel = nextLabel;
      detail = "";
      startedAtRef.value = Date.now();
      active = true;
      render();
      timer = setInterval(render, TICK_MS);
      timer.unref?.();
    },
    update(nextLabel, nextDetail = "") {
      currentLabel = nextLabel;
      detail = nextDetail;
      render();
    },
    /** Stop and print a permanent status line. */
    stop(text = "", { tone = "success" } = {}) {
      if (!active) {
        if (text) {
          if (target) {
            target.write(`${toneColor(tone)(text)}\n`);
            target.render();
          } else {
            output.write(`${text}\n`);
          }
        }
        return;
      }
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      const elapsed = formatElapsed(Date.now() - startedAt());
      if (target) {
        target.setActivity(null);
        target.write(text ? `${toneColor(tone)(text)} ${colors.faint(elapsed)}\n` : "");
        target.render();
        return;
      }
      frame.erase();
      if (text) output.write(`${toneColor(tone)(text)} ${colors.faint(elapsed)}\n`);
    },
  };
}

/**
 * Run `task` under a spinner, optionally listening for Ctrl+C / Esc so the
 * operation can be cancelled without killing the session.
 *
 * @returns {Promise<{ok:boolean, value?:any, error?:Error, cancelled:boolean}>}
 */
export async function runWithSpinner(label, task, { listen = true, input = process.stdin, output = process.stdout, signal: externalSignal = null, screen = undefined } = {}) {
  const target = screen === null ? null : screen ?? Screen.current;
  const spinner = createSpinner({ output, screen: target });
  const controller = new AbortController();
  const cancellable = listen && input.isTTY && typeof input.setRawMode === "function";

  const onExternalAbort = () => controller.abort(externalSignal?.reason ?? new Error("Cancelled"));
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // Keys typed while the call runs are replayed into the next prompt (type-ahead),
  // except the ones that drive the transcript: scrolling must work mid-call.
  const decoder = createKeyDecoder({ mouse: Boolean(target) });
  const forward = (raw) => {
    for (const event of decoder.push(raw)) {
      if (target && target.handleKey(event)) target.render();
      else pushBytes(event.sequence ?? "");
    }
  };

  const onData = (chunk) => {
    const { cancel, rest } = splitCancelChunk(chunk.toString("utf8"));
    if (rest) forward(rest);
    if (cancel) {
      spinner.update(label, "cancelling… (Ctrl+C)");
      controller.abort(new Error("Cancelled by user"));
    }
  };

  spinner.start(label);
  let detachConsumer = null;
  if (cancellable) {
    input.setRawMode(true);
    input.resume();
    if (target) detachConsumer = target.setInputConsumer(onData);
    else input.on("data", onData);
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
      if (detachConsumer) { detachConsumer(); detachConsumer = null; }
      if (!target) {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
      }
      // The screen owns the terminal modes for the whole session; a one-shot
      // call (no screen) has to give bracketed paste / keyboard flags back.
      if (!target) output.write(TERMINAL_MODES.leave);
    }
    if (target) {
      for (const event of decoder.forceFlush()) pushBytes(event.sequence ?? "");
      decoder.reset();
    }
  }
}

export { formatElapsed, visibleWidth };
