// Helm-style multi-pattern matching.
//
// The query is split on whitespace. Every positive term must match (in any order);
// a term starting with "!" excludes candidates containing it. Each term matches as a
// substring when possible, otherwise as a fuzzy subsequence. Matching is
// case-insensitive unless the term contains an uppercase letter (smart case).

const BOUNDARY = new Set([' ', '-', '_', '/', '.', ':', '\\', '(', '<', '[', '*']);

function isBoundary(s, i) {
  if (i === 0) return true;
  const p = s[i - 1];
  if (BOUNDARY.has(p)) return true;
  // camelCase transition
  return p >= 'a' && p <= 'z' && s[i] >= 'A' && s[i] <= 'Z';
}

export function compileQuery(query) {
  const terms = [];
  for (const raw of query.trim().split(/\s+/)) {
    if (!raw) continue;
    const neg = raw.startsWith('!') && raw.length > 1;
    const text = neg ? raw.slice(1) : raw;
    const caseSensitive = text !== text.toLowerCase();
    terms.push({ text: caseSensitive ? text : text.toLowerCase(), neg, caseSensitive });
  }
  return { query, terms, hasNegation: terms.some((t) => t.neg), empty: terms.length === 0 };
}

function matchTerm(term, label, lower) {
  const hay = term.caseSensitive ? label : lower;
  const t = term.text;
  const idx = hay.indexOf(t);
  if (idx >= 0) {
    let score = 50 + t.length * 2;
    if (idx === 0) score += 40;
    else if (isBoundary(label, idx)) score += 25;
    const positions = [];
    for (let i = 0; i < t.length; i++) positions.push(idx + i);
    return { score, positions };
  }
  // Fuzzy: greedy subsequence, preferring word boundaries when the next char occurs at one.
  const positions = [];
  let from = 0;
  let score = 0;
  let prev = -2;
  let allBoundaries = true;
  for (const ch of t) {
    let found = -1;
    // Look ahead a little for a boundary occurrence of this char.
    let first = hay.indexOf(ch, from);
    if (first < 0) return null;
    found = first;
    for (let j = first; j >= 0 && j < hay.length && j < first + 24; j = hay.indexOf(ch, j + 1)) {
      if (isBoundary(label, j)) { found = j; break; }
    }
    const boundary = isBoundary(label, found);
    if (!boundary) allBoundaries = false;
    if (found === prev + 1) score += 6;
    else if (boundary) score += 12;
    else score -= Math.min(found - prev, 10) * 0.5;
    positions.push(found);
    prev = found;
    from = found + 1;
  }
  // Initials ("ff" -> find-file) beat a substring buried mid-word.
  if (allBoundaries && t.length > 1) score += 40;
  return { score: score + 10, positions };
}

/** Match a label against a compiled query. Returns { score, positions } or null. */
export function matchLabel(compiled, label) {
  if (compiled.empty) return { score: 0, positions: [] };
  const lower = label.toLowerCase();
  let score = 0;
  let positions = [];
  for (const term of compiled.terms) {
    if (term.neg) {
      const hay = term.caseSensitive ? label : lower;
      if (hay.includes(term.text)) return null;
      continue;
    }
    const m = matchTerm(term, label, lower);
    if (!m) return null;
    score += m.score;
    positions = positions.concat(m.positions);
  }
  // Prefer shorter candidates when scores tie.
  score -= label.length * 0.05;
  return { score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

/**
 * Filter and sort candidates. `cands` are normalized ({ label, ... }).
 * Returns [{ cand, score, positions }], best first; original order for an empty query.
 */
export function filterCandidates(compiled, cands) {
  if (compiled.empty) return cands.map((cand) => ({ cand, score: 0, positions: [] }));
  const out = [];
  for (const cand of cands) {
    const m = matchLabel(compiled, cand.label);
    if (m) out.push({ cand, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Whether results for `prev` can be narrowed to get results for `next`. */
export function canNarrow(prev, next) {
  if (prev === null || prev === undefined) return false;
  if (prev.includes('!') || next.includes('!')) return false;
  return next.startsWith(prev) && prev.trim().length > 0;
}
