// Deliberately no dependency for this -- five ANSI codes don't need a
// library. Colors are disabled when stdout isn't a TTY (piping/redirecting
// output) or when NO_COLOR is set, per https://no-color.org. MCP_DEV_COLOR
// forces the decision explicitly when TTY auto-detection gets it wrong on a
// given terminal (some Windows console hosts don't report isTTY the way
// Node expects even though they render ANSI fine).
const forced = process.env.MCP_DEV_COLOR;
const enabled = forced !== undefined
  ? forced !== "0" && forced.toLowerCase() !== "false"
  : Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(open, close) {
  return enabled ? (s) => `\x1b[${open}m${s}\x1b[${close}m` : (s) => String(s);
}

export const colors = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const style = {
  error: colors.red,
  success: colors.green,
  warning: colors.yellow,
  prompt: colors.cyan,
  heading: (s) => colors.bold(colors.cyan(s)),
  serverName: colors.blue,
  toolName: (s) => colors.bold(colors.magenta(s)),
  required: colors.yellow,
  muted: colors.gray,
};