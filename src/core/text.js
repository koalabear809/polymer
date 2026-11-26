// Text storage.
//
// A buffer's text is an array of lines (without newlines). Positions are integer
// offsets into the text as if lines were joined with "\n" (like Emacs points, but
// 0-based). Columns are UTF-16 code units.
//
// Everything goes through this small API, so the backing structure can later become a
// piece table or rope without touching callers.

const SPLICE_CHUNK = 10000;

function replaceLines(lines, start, deleteCount, items) {
  if (items.length < SPLICE_CHUNK) {
    lines.splice(start, deleteCount, ...items);
    return lines;
  }
  // Avoid exceeding argument limits for huge inserts.
  return lines.slice(0, start).concat(items, lines.slice(start + deleteCount));
}

export class Text {
  constructor(str = '') {
    this.lines = str.split('\n');
    this.len = str.length;
    this.starts = [0];   // line start offsets, valid for indices < startsValid
    this.startsValid = 1;
  }

  get length() { return this.len; }
  get lineCount() { return this.lines.length; }

  line(n) { return this.lines[n] ?? ''; }

  lineStart(n) {
    if (n <= 0) return 0;
    if (n >= this.lines.length) n = this.lines.length - 1;
    this.computeStarts(n);
    return this.starts[n];
  }

  lineEnd(n) { return this.lineStart(n) + this.line(n).length; }

  computeStarts(upTo) {
    if (upTo < this.startsValid) return;
    const { lines, starts } = this;
    for (let i = this.startsValid; i <= upTo; i++) starts[i] = starts[i - 1] + lines[i - 1].length + 1;
    this.startsValid = upTo + 1;
  }

  invalidate(fromLine) {
    const valid = Math.max(1, fromLine + 1);
    if (valid < this.startsValid) {
      this.startsValid = valid;
      this.starts.length = valid;
    }
  }

  /** Line number containing `offset`. */
  lineAt(offset) {
    offset = this.clamp(offset);
    this.computeStarts(this.lines.length - 1);
    const s = this.starts;
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** { line, col } for an offset. */
  posAt(offset) {
    const line = this.lineAt(offset);
    return { line, col: this.clamp(offset) - this.lineStart(line) };
  }

  /** Offset for a line/column; both are clamped. */
  offsetAt(line, col) {
    line = Math.max(0, Math.min(this.lines.length - 1, line));
    col = Math.max(0, Math.min(this.lines[line].length, col));
    return this.lineStart(line) + col;
  }

  clamp(offset) { return Math.max(0, Math.min(this.len, offset)); }

  charAt(offset) {
    const { line, col } = this.posAt(offset);
    const l = this.lines[line];
    return col < l.length ? l[col] : (line < this.lines.length - 1 ? '\n' : '');
  }

  slice(from = 0, to = this.len) {
    from = this.clamp(from);
    to = this.clamp(to);
    if (from >= to) return '';
    const a = this.posAt(from);
    const b = this.posAt(to);
    if (a.line === b.line) return this.lines[a.line].slice(a.col, b.col);
    const parts = [this.lines[a.line].slice(a.col)];
    for (let i = a.line + 1; i < b.line; i++) parts.push(this.lines[i]);
    parts.push(this.lines[b.line].slice(0, b.col));
    return parts.join('\n');
  }

  toString() { return this.lines.join('\n'); }

  /** Insert `str` at `offset`. */
  insert(offset, str) {
    if (!str) return;
    offset = this.clamp(offset);
    const { line, col } = this.posAt(offset);
    const cur = this.lines[line];
    const before = cur.slice(0, col);
    const after = cur.slice(col);
    const parts = str.split('\n');
    if (parts.length === 1) {
      this.lines[line] = before + str + after;
    } else {
      parts[0] = before + parts[0];
      parts[parts.length - 1] += after;
      this.lines = replaceLines(this.lines, line, 1, parts);
    }
    this.len += str.length;
    this.invalidate(line);
  }

  /** Delete [from, to). Returns the removed text. */
  delete(from, to) {
    from = this.clamp(from);
    to = this.clamp(to);
    if (from >= to) return '';
    const removed = this.slice(from, to);
    const a = this.posAt(from);
    const b = this.posAt(to);
    const joined = this.lines[a.line].slice(0, a.col) + this.lines[b.line].slice(b.col);
    this.lines = replaceLines(this.lines, a.line, b.line - a.line + 1, [joined]);
    this.len -= to - from;
    this.invalidate(a.line);
    return removed;
  }

  /** Length of the longest line (used for horizontal scrolling). */
  maxLineLength() {
    let m = 0;
    for (const l of this.lines) if (l.length > m) m = l.length;
    return m;
  }
}
