// src/colors.js
// Unified, high-contrast palette for every renderer (session UI, markdown,
// render, help). Keep secondary text readable on the common dark terminal
// background: avoid xterm's near-black 238/244 grays and dim-video SGR.
//
// Colour state is evaluated on every call rather than at import time so the
// session's `/color` command can switch modes live without reloading modules.

const ENV_MODE = process.env.MCP_DEV_COLOR;

let mode = "auto";
if (ENV_MODE !== undefined) {
  const value = ENV_MODE.toLowerCase();
  if (value === "0" || value === "false") mode = "never";
  else if (value === "basic") mode = "basic";
  else if (value === "never" || value === "no") mode = "never";
  else if (value === "always") mode = "always";
}
if (process.env.NO_COLOR !== undefined && ENV_MODE === undefined) mode = "never";

export function setColorMode(next) {
  if (["auto", "always", "never", "basic"].includes(next)) mode = next;
  return mode;
}

export function getColorMode() {
  return mode;
}

export function colorEnabled() {
  if (mode === "never") return false;
  if (mode === "always" || mode === "basic") return true;
  return Boolean(process.stdout.isTTY);
}

function wrap256(code) {
  return (s) => colorEnabled() ? `\x1b[38;5;${code}m${s}\x1b[0m` : String(s);
}

function wrapBasic(open, close) {
  return (s) => colorEnabled() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
}

function wrapAttr(code) {
  return (s) => colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : String(s);
}

function wrapBg(bg, fg = 231) {
  return (s) => colorEnabled() ? `\x1b[48;5;${bg}m\x1b[38;5;${fg}m${s}\x1b[0m` : String(s);
}

function pick(basicCode, basicClose, code256) {
  return (s) => (mode === "basic" ? wrapBasic(basicCode, basicClose)(s) : wrap256(code256)(s));
}

export const colors = {
  bold: wrapAttr(1),
  // Use actual medium-light foregrounds instead of dim-video, which many
  // terminal themes render too dark to read against a black background.
  dim: pick(37, 39, 245),
  faint: pick(37, 39, 245),
  italic: wrapAttr(3),
  underline: wrapAttr(4),
  inverse: wrapAttr(7),

  body: (s) => (mode === "basic" ? String(s) : wrap256(252)(s)),

  red: pick(91, 39, 203),
  green: pick(92, 39, 114),
  yellow: pick(93, 39, 220),
  blue: pick(94, 39, 75),
  magenta: pick(95, 39, 177),
  cyan: pick(96, 39, 81),
  gray: pick(37, 39, 250),

  accent: pick(96, 39, 81),
  secondary: pick(94, 39, 75),
  identifier: pick(93, 39, 221),
  success: pick(92, 39, 114),
  warning: pick(93, 39, 220),
  error: pick(91, 39, 203),
  emphasis: pick(95, 39, 177),
};

// Aliases used across the session UI.
colors.muted = colors.gray;
colors.path = colors.blue;
colors.string = colors.green;
colors.keyword = colors.magenta;
colors.punctuation = colors.gray;

export const marks = {
  ok: () => colors.success("✓"),
  fail: () => colors.error("✗"),
  warn: () => colors.warning("!"),
  info: () => colors.accent("i"),
  pointer: () => colors.accent("▸"),
  bullet: () => colors.muted("·"),
  arrow: () => colors.accent("❯"),
  separator: () => colors.faint("─"),
  prompt: () => colors.accent("❯"),
  cached: () => colors.warning("◆"),
};

export const badges = {
  cmd: (s) => (colorEnabled() ? wrapBg(60)(` ${s} `) : `[${s}]`),
  server: (s) => (colorEnabled() ? wrapBg(24)(` ${s} `) : `[${s}]`),
  tool: (s) => (colorEnabled() ? wrapBg(90)(` ${s} `) : `[${s}]`),
  chat: (s) => (colorEnabled() ? wrapBg(29)(` ${s} `) : `[${s}]`),
  cache: (s) => (colorEnabled() ? wrapBg(94)(` ${s} `) : `[${s}]`),
  path: (s) => (colorEnabled() ? wrapBg(238)(` ${s} `) : `[${s}]`),
  hint: (s) => (colorEnabled() ? wrapBg(238)(` ${s} `) : `[${s}]`),
};

export const style = {
  error: colors.error,
  success: colors.success,
  warning: colors.warning,
  prompt: colors.accent,
  bold: (s) => colors.bold(s),
  heading: (s) => colors.bold(colors.accent(s)),
  subheading: (s) => colors.bold(colors.body(s)),
  serverName: colors.secondary,
  toolName: (s) => colors.bold(colors.emphasis(s)),

  // Fuzzy-match highlight for palette rows.
  match: (s) => colors.bold(colors.accent(s)),
  pointer: (s) => colors.accent(s),
  selected: (s) => colors.bold(s),

  required: colors.yellow,
  muted: colors.gray,
  faint: colors.faint,
  body: colors.body,

  key: (s) => colors.bold(colors.body(s)),
  value: colors.green,
  number: colors.yellow,
  boolean: colors.magenta,
  null: colors.magenta,
  punch: colors.cyan,
  path: (s) => colors.blue(s),
  schemaKey: colors.cyan,
  schemaType: colors.gray,
  hidden: colors.faint,
};
