// src/colors.js
// Unified high-end palette for all renderers (markdown, render, session, etc.)

const forced = process.env.MCP_DEV_COLOR;
const disabled =
  forced !== undefined &&
  (forced === "0" || forced.toLowerCase() === "false");

const enabled =
  forced !== undefined ? !disabled :
    Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const useBasic = forced === "basic";

function wrap256(code) {
  return enabled
    ? (s) => `\x1b[38;5;${code}m${s}\x1b[0m`
    : (s) => String(s);
}

function wrapBasic(open, close) {
  return enabled
    ? (s) => `\x1b[${open}m${s}\x1b[${close}m`
    : (s) => String(s);
}

function wrapAttr(code) {
  return enabled
    ? (s) => `\x1b[${code}m${s}\x1b[0m`
    : (s) => String(s);
}

export const colors = {
  bold: wrapAttr(1),
  dim: useBasic ? wrapBasic(2, 22) : wrap256(244),
  faint: wrap256(238),

  body: useBasic ? (s) => String(s) : wrap256(250),

  red: useBasic ? wrapBasic(31, 39) : wrap256(167),
  green: useBasic ? wrapBasic(32, 39) : wrap256(108),
  yellow: useBasic ? wrapBasic(33, 39) : wrap256(180),
  blue: useBasic ? wrapBasic(34, 39) : wrap256(67),
  magenta: useBasic ? wrapBasic(35, 39) : wrap256(141),
  cyan: useBasic ? wrapBasic(36, 39) : wrap256(109),
  gray: useBasic ? wrapBasic(90, 39) : wrap256(244),

  accent: wrap256(109),
  secondary: wrap256(67),
  identifier: wrap256(180),
  success: wrap256(108),
  warning: wrap256(174),
  error: wrap256(167),
  emphasis: wrap256(141),
};

export const style = {
  error: colors.error,
  success: colors.success,
  warning: colors.warning,
  prompt: colors.accent,
  bold: (s) => colors.bold(s),
  heading: (s) => colors.bold(colors.accent(s)),
  serverName: colors.secondary,
  toolName: (s) => colors.bold(colors.emphasis(s)),

  required: colors.yellow,
  muted: colors.gray,
  faint: colors.faint,
  body: colors.body,
};