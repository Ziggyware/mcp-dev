const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_RE, "");
}

/**
 * A conservative terminal-width calculation. Array.from handles surrogate
 * pairs correctly; East Asian ambiguous-width characters intentionally count
 * as one so output remains predictable on terminals with different policies.
 */
export function visibleWidth(value) {
  return Array.from(stripAnsi(value)).length;
}

export function clipText(value, width, ellipsis = "…") {
  const text = String(value ?? "");
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width <= visibleWidth(ellipsis)) return ellipsis.slice(0, width);

  let result = "";
  let used = 0;
  // This function is used on unstyled text for table cells. Preserve ANSI
  // sequences if one happens to be present rather than counting them as text.
  for (const token of text.match(/\x1B\[[0-?]*[ -/]*[@-~]|[\s\S]/g) ?? []) {
    if (ANSI_RE.test(token)) {
      result += token;
      ANSI_RE.lastIndex = 0;
      continue;
    }
    if (used + 1 > width - visibleWidth(ellipsis)) break;
    result += token;
    used += 1;
  }
  return result + ellipsis;
}

export function terminalColumns(fallback = 88) {
  const columns = Number(process.stdout.columns);
  return Number.isFinite(columns) && columns >= 40 ? columns : fallback;
}

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|password|auth|credential)/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
