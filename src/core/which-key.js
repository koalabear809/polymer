// which-key: after a prefix key, show the keys that can follow it.

let el = null;
let visible = false;

export function attachWhichKey(element) { el = element; }
export const whichKeyVisible = () => visible;

// Plain characters first (lowercase, then uppercase), then modified and special keys.
function keyRank(k) {
  if (/^[a-z]$/.test(k)) return 0;
  if (/^[A-Z]$/.test(k)) return 1;
  if (k.length === 1) return 2;
  if (k === 'SPC' || k === 'TAB' || k === 'RET') return 3;
  return 4;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => keyRank(a.key) - keyRank(b.key) || a.key.localeCompare(b.key));
}

function describe(entry) {
  if (entry.label) return entry.prefix ? `+${entry.label}` : entry.label;
  if (entry.prefix) return '+prefix';
  if (typeof entry.cmd === 'function') return entry.cmd.name || 'λ';
  return entry.cmd;
}

export function showWhichKey(prefix, entries) {
  if (!el) return;
  const header = document.createElement('div');
  header.className = 'wk-header';
  header.textContent = `${prefix}-`;
  const grid = document.createElement('div');
  grid.className = 'wk-grid';
  for (const e of sortEntries(entries)) {
    const item = document.createElement('div');
    item.className = 'wk-item';
    const k = document.createElement('span');
    k.className = 'wk-key';
    k.textContent = e.key;
    const arrow = document.createElement('span');
    arrow.className = 'wk-arrow';
    arrow.textContent = '→';
    const d = document.createElement('span');
    d.className = e.prefix ? 'wk-desc wk-prefix' : 'wk-desc';
    d.textContent = describe(e);
    item.append(k, arrow, d);
    grid.appendChild(item);
  }
  el.replaceChildren(header, grid);
  el.hidden = false;
  visible = true;
}

export function hideWhichKey() {
  if (!el || !visible) return;
  el.hidden = true;
  visible = false;
}
