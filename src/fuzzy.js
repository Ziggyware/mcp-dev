/**
 * Fuzzy matching for the interactive prompt.
 *
 * `fuzzyMatch` finds the characters of `query` inside `target` in order and
 * scores the result the way fuzzy finders do: matches at word boundaries and
 * consecutive runs score best, gaps score worse, and a literal prefix is best
 * of all. `rankByFuzzy` sorts a list of items without mutating them.
 */

const BOUNDARY_BEFORE = /[\s/._\-:!]/;

export function fuzzyMatch(query, target, { caseSensitive = null } = {}) {
  const needle = String(query ?? "");
  const haystack = String(target ?? "");
  if (needle === "") return { score: 0, indices: [] };
  if (haystack === "") return null;

  // Smart case: a typed capital means the user cares about case.
  const sensitive = caseSensitive ?? /[A-Z]/.test(needle);
  const normalizedNeedle = sensitive ? needle : needle.toLowerCase();
  const normalizedHaystack = sensitive ? haystack : haystack.toLowerCase();

  const indices = [];
  let cursor = 0;
  for (const char of normalizedNeedle) {
    const found = normalizedHaystack.indexOf(char, cursor);
    if (found === -1) return null;
    indices.push(found);
    cursor = found + 1;
  }

  let score = 0;
  let previous = -2;
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    if (index === previous + 1) score += 8;
    else if (i > 0) score -= Math.min(6, index - previous - 1);
    previous = index;

    if (index === 0) score += 10;
    else if (BOUNDARY_BEFORE.test(haystack[index - 1] ?? "")) score += 6;
    else if (haystack[index - 1] === haystack[index - 1]?.toUpperCase?.() && haystack[index] !== haystack[index].toLowerCase()) score += 3;
  }

  // Prefer shorter targets and matches that start early.
  score -= Math.max(0, Math.min(8, Math.floor((haystack.length - needle.length) / 6)));
  if (indices[0] === 0 && normalizedHaystack.startsWith(normalizedNeedle)) score += 12;
  return { score, indices };
}

export function rankByFuzzy(items, query, { key = "searchText", limit = null } = {}) {
  const needle = String(query ?? "");
  const ranked = [];
  for (const item of items ?? []) {
    const haystack = typeof key === "function" ? key(item) : item?.[key];
    const match = fuzzyMatch(needle, haystack ?? "");
    if (!match) continue;
    ranked.push({ item, score: match.score, indices: match.indices });
  }
  ranked.sort((a, b) => b.score - a.score);
  return limit ? ranked.slice(0, limit) : ranked;
}

/** Apply terminal styling to the matched characters of `text`. */
export function highlightMatches(text, indices, style) {
  if (!indices?.length) return text;
  const set = new Set(indices);
  let out = "";
  for (let i = 0; i < text.length; i += 1) out += set.has(i) ? style(text[i]) : text[i];
  return out;
}
