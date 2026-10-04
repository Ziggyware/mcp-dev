/**
 * Small, shell-like parsers used for values that must be stored as an argv
 * array. We intentionally do not invoke a shell: these parsers only split
 * input, so registering a server cannot accidentally evaluate shell syntax.
 */

export class ArgumentParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentParseError";
  }
}

/**
 * Split a command-line fragment into argv values.
 *
 * Supports single quotes, double quotes, and a backslash escape outside of
 * single quotes. Shell expansion, command substitution, globbing, and
 * environment interpolation are deliberately not supported.
 */
export function parseCommandArguments(input) {
  const text = String(input ?? "");
  const args = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      current += char;
      escaped = false;
      hasToken = true;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      hasToken = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      hasToken = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escaped) {
    throw new ArgumentParseError("Arguments end with an unfinished backslash escape.");
  }
  if (quote) {
    throw new ArgumentParseError(`Arguments contain an unclosed ${quote === "'" ? "single" : "double"} quote.`);
  }
  if (hasToken) args.push(current);
  return args;
}

/**
 * Split a comma-delimited value while respecting the same quoting and escape
 * rules as parseCommandArguments. Delimiters are removed but quotes remain
 * available to the caller only through their effect on splitting.
 */
export function splitDelimited(input, delimiter = ",") {
  const text = String(input ?? "");
  const values = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === delimiter) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (escaped) throw new ArgumentParseError("Value ends with an unfinished backslash escape.");
  if (quote) throw new ArgumentParseError("Value contains an unclosed quote.");
  values.push(current.trim());
  return values;
}

/** Parse KEY=VALUE pairs without losing values that themselves contain '='. */
export function parseEnvAssignments(input) {
  const env = {};
  for (const pair of splitDelimited(input).filter(Boolean)) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw new ArgumentParseError(`Expected KEY=VALUE, received "${pair}".`);
    }
    const key = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ArgumentParseError(`"${key}" is not a valid environment-variable name.`);
    }
    env[key] = value;
  }
  return env;
}

export function parseJson(text, label = "JSON") {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ArgumentParseError(`${label} is not valid JSON: ${error.message}`);
  }
}
