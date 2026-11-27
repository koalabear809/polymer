// Markdown -> display lines for agent buffers.
//
// renderMarkdown(text, opts) returns [{ text, decos, lineFace? }]: the text with the markup
// removed (**bold** -> bold, "## H" -> H, "- x" -> "• x", tables drawn with box characters,
// ...) and decorations ({ from, to, face, url? }) that style what the markup meant. The
// source stays Markdown (transcripts save it as is); this only shapes what is displayed.
//
// It re-parses the whole message each time, so streaming needs no special care: markup
// whose closing half hasn't arrived yet is simply shown as typed until it does.

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const BULLETS = ['•', '◦', '▪'];

// ---------------------------------------------------------------------------
// Inline: `code`, **bold**, *italic*, ~~strike~~, [links](url), <autolinks>, \escapes

const isSpace = (c) => c === undefined || /\s/.test(c);
const isWord = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Index just past the code span opening at i (a run of backticks), or -1 if unclosed. */
function codeSpanEnd(s, i) {
  let n = 0;
  while (s[i + n] === '`') n++;
  const tick = '`'.repeat(n);
  for (let j = s.indexOf(tick, i + n); j >= 0; j = s.indexOf(tick, j + 1)) {
    let m = 0;
    while (s[j + m] === '`') m++;
    if (m === n) return j + n;
    j += m - 1;
  }
  return -1;
}

/** Index of the delimiter closing one opened at i (delim is *, _, **, __ or ~~), or -1. */
function findCloser(s, i, delim) {
  const d = delim.length;
  const c = delim[0];
  for (let j = i + d + 1; j <= s.length - d; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '`') { const e = codeSpanEnd(s, j); if (e > 0) { j = e - 1; continue; } }
    if (!s.startsWith(delim, j) || isSpace(s[j - 1])) continue;
    if (d === 1) {
      // A single * or _ must not be half of a ** / __ pair.
      if (s[j + 1] === c || s[j - 1] === c) { while (s[j + 1] === c) j++; continue; }
    } else if (s[j + d] === c && s[j + d + 1] !== c) {
      continue; // "***": let the outer single delimiter take the last one
    }
    if (c === '_' && isWord(s[j + d])) continue; // snake_case is not emphasis
    return j;
  }
  return -1;
}

/** Parse inline markup: { text, decos }. */
export function renderInline(src) {
  let text = '';
  const decos = [];
  const nest = (inner, face, extra) => {
    const r = renderInline(inner);
    const from = text.length;
    for (const d of r.decos) decos.push({ ...d, from: d.from + from, to: d.to + from });
    text += r.text;
    decos.push({ from, to: text.length, face, ...extra });
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && /[!-/:-@[-`{-~]/.test(src[i + 1] ?? '')) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = codeSpanEnd(src, i);
      if (end > 0) {
        let n = 0;
        while (src[i + n] === '`') n++;
        let code = src.slice(i + n, end - n);
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        decos.push({ from: text.length, to: text.length + code.length, face: 'agent-code' });
        text += code;
        i = end;
        continue;
      }
      while (src[i] === '`') text += src[i++];
      continue;
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const m = /^!?\[((?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'(][^)]*["')])?\s*\)/.exec(src.slice(i));
      if (m) {
        const image = ch === '!';
        // Images keep a text label (the picture itself is shown below the line by the caller).
        nest(image ? `[image: ${m[1] || m[2]}]` : (m[1] || m[2]), 'agent-link', { url: m[2], ...(image ? { picture: true, alt: m[1] } : {}) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<((?:https?|mailto|file):[^\s<>]+)>/.exec(src.slice(i));
      if (m) {
        decos.push({ from: text.length, to: text.length + m[1].length, face: 'agent-link', url: m[1] });
        text += m[1];
        i += m[0].length;
        continue;
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (src[i + run] === ch) run++;
      const opensOk = !isSpace(src[i + run]) && !(ch === '_' && isWord(src[i - 1]));
      if (opensOk) {
        // Try the longest sensible delimiter first: ** before *, and ~~ only (no single ~).
        const tries = ch === '~' ? (run >= 2 ? ['~~'] : []) : run >= 2 ? [ch + ch, ch] : [ch];
        let done = false;
        for (const delim of tries) {
          const j = findCloser(src, i, delim);
          if (j < 0) continue;
          const face = ch === '~' ? 'agent-strike' : delim.length === 2 ? 'agent-bold' : 'agent-italic';
          nest(src.slice(i + delim.length, j), face);
          i = j + delim.length;
          done = true;
          break;
        }
        if (done) continue;
      }
      text += src.slice(i, i + run);
      i += run;
      continue;
    }
    text += ch;
    i++;
  }
  return { text, decos };
}

// ---------------------------------------------------------------------------
// Tables

/** Split a table row into cell sources (pipes inside code spans or escaped don't split). */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '`') {
      const e = codeSpanEnd(s, i);
      if (e > 0) { cur += s.slice(i, e); i = e - 1; continue; }
    }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Lines for a table, or null if it doesn't fit in `columns`. */
function renderTable(rows, aligns, columns) {
  const n = Math.max(aligns.length, ...rows.map((r) => r.length));
  const cells = rows.map((r) => Array.from({ length: n }, (_, k) => renderInline(r[k] ?? '')));
  const widths = Array.from({ length: n }, (_, k) => Math.max(1, ...cells.map((r) => r[k].text.length)));
  const total = widths.reduce((s, w) => s + w + 3, 1);
  if (columns && total > columns) return null;
  const border = (l, m, r) => ({
    text: l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r,
    decos: [{ from: 0, to: total, face: 'agent-table-border' }],
  });
  const row = (r, header) => {
    let text = '│';
    const decos = [{ from: 0, to: 1, face: 'agent-table-border' }];
    r.forEach((c, k) => {
      const room = widths[k] - c.text.length;
      const left = aligns[k] === 'right' ? room : aligns[k] === 'center' ? Math.floor(room / 2) : 0;
      const at = text.length + 1 + left;
      for (const d of c.decos) decos.push({ ...d, from: d.from + at, to: d.to + at });
      if (header) decos.push({ from: at, to: at + c.text.length, face: 'agent-bold' });
      text += ` ${' '.repeat(left)}${c.text}${' '.repeat(room - left)} │`;
      decos.push({ from: text.length - 1, to: text.length, face: 'agent-table-border' });
    });
    return { text, decos };
  };
  return [
    border('┌', '┬', '┐'),
    row(cells[0], true),
    border('├', '┼', '┤'),
    ...cells.slice(1).map((r) => row(r, false)),
    border('└', '┴', '┘'),
  ];
}

// ---------------------------------------------------------------------------
// Blocks

/**
 * Render a Markdown message.
 *   highlight(lang, code) -> Map(row -> decos) | null   syntax highlighting for fenced code
 *   columns                                              window width (rules, tables)
 *   raw                                                  keep the markup; only add faces
 */
export function renderMarkdown(src, { highlight = () => null, columns = 80, raw = false } = {}) {
  const lines = tidy(src);
  const out = [];
  // Blocks of different kinds (a heading and its text, a paragraph and the list or code
  // after it, ...) get a blank line between them even when the source has none, so a reply
  // doesn't read as one clump. A heading stays attached to what follows it.
  let prev = null;
  let blockId = 0;
  const emit = (kind, ...ls) => {
    if (!raw && prev && prev !== 'blank' && prev !== 'heading' && kind !== 'blank' && kind !== prev) out.push({ text: '', decos: [] });
    out.push(...ls);
    prev = kind;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // Fenced code (an unclosed fence runs to the end: the rest is still streaming in).
    const open = FENCE.exec(l);
    if (open) {
      const marker = open[2];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[j])) j++;
      const indent = open[1].length;
      const body = lines.slice(i + 1, j).map((x) => x.slice(Math.min(indent, /^\s*/.exec(x)[0].length)));
      const hl = open[3] ? highlight(open[3], body.join('\n')) : null;
      const label = raw ? l : open[3];
      const block = [{ text: label, decos: [{ from: 0, to: label.length, face: 'agent-dim' }], lineFace: 'agent-codeline' }];
      body.forEach((x, row) => block.push({ text: x, decos: hl?.get(row) ?? [], lineFace: 'agent-codeline' }));
      if (j < lines.length) {
        const close = raw ? lines[j] : '';
        block.push({ text: close, decos: [{ from: 0, to: close.length, face: 'agent-dim' }], lineFace: 'agent-codeline' });
      }
      emit(`code${++blockId}`, ...block);
      i = j;
      continue;
    }

    if (raw) {
      emit('raw', rawLine(l));
      continue;
    }

    // Tables: a row of cells, then a |---|:--:| line.
    if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|') && splitRow(l).length === splitRow(lines[i + 1]).length) {
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      const rows = [splitRow(l)];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(splitRow(lines[j++]));
      const table = renderTable(rows, aligns, columns);
      if (table) {
        emit(`table${++blockId}`, ...table);
        i = j - 1;
        continue;
      }
    }

    // Setext headings: a line underlined with === or ---.
    const next = lines[i + 1];
    if (l.trim() && next !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(next) && !BULLET.test(l) && !QUOTE.test(l) && !HEADING.test(l) && !RULE.test(l) && !l.includes("|")) {
      emit('heading', heading(l.trim(), next.trim()[0] === '=' ? 1 : 2));
      i++;
      continue;
    }

    emit(lineKind(l, prev), blockLine(l, columns));
  }
  return out;
}

/** The kind of block a line outside code and tables belongs to (for spacing). */
function lineKind(l, prev) {
  if (!l.trim()) return 'blank';
  if (QUOTE.test(l)) return 'quote';
  if (HEADING.test(l)) return 'heading';
  if (RULE.test(l)) return 'rule';
  if (BULLET.test(l) || ORDERED.test(l)) return 'list';
  // Indented text under a list item continues it; unindented text after a list is a new
  // paragraph (agents often leave out the blank line before it).
  return prev === 'list' && /^\s+\S/.test(l) ? 'list' : 'text';
}

/** Lines with trailing space dropped and blank runs (outside code) collapsed; ends trimmed. */
function tidy(src) {
  const out = [];
  let fence = null;
  for (const l of src.split('\n')) {
    const f = FENCE.exec(l);
    if (fence ? new RegExp(`^\\s*\\${fence[0]}{${fence.length},}\\s*$`).test(l) : f) fence = fence ? null : f[2];
    if (fence) { out.push(l); continue; }
    if (!l.trim()) { if (out.length && out.at(-1) !== '') out.push(''); } else out.push(l.replace(/\s+$/, ''));
  }
  while (out.at(-1) === '') out.pop();
  while (out[0] === '') out.shift();
  return out;
}

function heading(src, level) {
  const r = renderInline(src);
  return { text: r.text, decos: [...r.decos, { from: 0, to: r.text.length, face: `agent-heading agent-h${level}` }] };
}

/** A line outside code and tables: heading, rule, quote, list item or paragraph text. */
function blockLine(l, columns, prefix = '', prefixDecos = []) {
  const p = prefix.length;
  // The prefix plus a rendered line whose decorations start at column 0.
  const withPrefix = (r) => clamp({
    text: prefix + r.text,
    decos: [...prefixDecos, ...r.decos.map((d) => ({ ...d, from: d.from + p, to: d.to + p }))],
  });

  const q = QUOTE.exec(l);
  if (q) {
    return blockLine(q[1], columns, `${prefix}│ `, [...prefixDecos, { from: p, to: p + 1, face: 'agent-quote-bar' }, { from: p, to: Infinity, face: 'agent-quote' }]);
  }
  const h = HEADING.exec(l);
  if (h) return withPrefix(heading(h[2], h[1].length));
  if (RULE.test(l)) {
    const text = '─'.repeat(Math.max(3, Math.min(columns ?? 80, 120) - p));
    return withPrefix({ text, decos: [{ from: 0, to: text.length, face: 'agent-rule' }] });
  }
  const b = BULLET.exec(l);
  const o = !b && ORDERED.exec(l);
  if (b || o) {
    const indent = (b ?? o)[1].replace(/\t/g, '    ');
    let marker = b ? BULLETS[Math.floor(indent.length / 2) % BULLETS.length] : `${o[2]}${o[3]}`;
    let body = b ? b[3] : o[4];
    let done = false;
    const t = TASK.exec(body);
    if (t) {
      done = t[1] !== ' ';
      marker = `${marker} ${done ? '☑' : '☐'}`;
      body = t[2];
    }
    const lead = `${indent}${marker} `;
    const r = renderInline(body);
    return withPrefix({
      text: lead + r.text,
      decos: [
        { from: indent.length, to: indent.length + marker.length, face: 'agent-bullet' },
        ...(done ? [{ from: lead.length, to: lead.length + r.text.length, face: 'agent-done' }] : []),
        ...r.decos.map((d) => ({ ...d, from: d.from + lead.length, to: d.to + lead.length })),
      ],
    });
  }
  return withPrefix(renderInline(l));
}

/** Decorations that ran "to the end of the line" (Infinity) end at the text's length. */
function clamp(line) {
  for (const d of line.decos) if (d.to === Infinity) d.to = line.text.length;
  return line;
}

/** Raw mode: the line as typed, with faces on headings, `code` and **bold**. */
function rawLine(l) {
  const decos = [];
  if (HEADING.test(l)) decos.push({ from: 0, to: l.length, face: 'agent-heading' });
  else {
    for (const m of l.matchAll(/`[^`]+`/g)) decos.push({ from: m.index, to: m.index + m[0].length, face: 'agent-code' });
    for (const m of l.matchAll(/\*\*[^*]+\*\*/g)) decos.push({ from: m.index, to: m.index + m[0].length, face: 'agent-bold' });
  }
  return { text: l, decos };
}
