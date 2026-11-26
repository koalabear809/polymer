// Undo and redo.
//
// Every edit records a change { from, removed, inserted }. Changes accumulate in an
// open group until an undo boundary (the command loop adds one between commands; the
// vim layer will group a whole insert session). Undo reverts the last group; redo
// re-applies it. Any new edit clears the redo list.

import { defvar, getVarOr } from './registry.js';

defvar('undo-limit', 2000, { doc: 'Maximum number of undo groups kept per buffer.' });

export function initUndo(buf) {
  buf.undoList = [];   // closed groups, oldest first
  buf.redoList = [];
  buf.undoGroup = null; // open group: { changes, pointBefore }
  buf.undoEnabled = true;
  buf.inUndo = false;
}

export function recordChange(buf, change) {
  if (!buf.undoEnabled || buf.inUndo) return;
  if (!buf.undoGroup) buf.undoGroup = { changes: [], pointBefore: buf.point.pos };
  const g = buf.undoGroup;
  // Merge consecutive single insertions (typing) into one change.
  const last = g.changes.at(-1);
  if (last && !change.removed && !last.removed && last.from + last.inserted.length === change.from) {
    last.inserted += change.inserted;
  } else {
    g.changes.push(change);
  }
  buf.redoList.length = 0;
}

/** Close the open undo group. */
export function undoBoundary(buf) {
  const g = buf?.undoGroup;
  if (!g) return;
  buf.undoGroup = null;
  if (!g.changes.length) return;
  g.pointAfter = buf.point.pos;
  buf.undoList.push(g);
  const limit = getVarOr('undo-limit', 2000);
  if (buf.undoList.length > limit) buf.undoList.splice(0, buf.undoList.length - limit);
}

function apply(buf, change, reverse) {
  const { from, removed, inserted } = change;
  if (reverse) {
    buf.deleteText(from, from + inserted.length, { inhibitReadOnly: true });
    buf.insertText(from, removed, { inhibitReadOnly: true });
  } else {
    buf.deleteText(from, from + removed.length, { inhibitReadOnly: true });
    buf.insertText(from, inserted, { inhibitReadOnly: true });
  }
}

/** Undo the last group. Returns false if there is nothing to undo. */
export function undo(buf) {
  undoBoundary(buf);
  const g = buf.undoList.pop();
  if (!g) return false;
  buf.inUndo = true;
  try {
    for (let i = g.changes.length - 1; i >= 0; i--) apply(buf, g.changes[i], true);
  } finally {
    buf.inUndo = false;
  }
  buf.redoList.push(g);
  buf.point.set(g.pointBefore);
  return true;
}

/** Redo the last undone group. Returns false if there is nothing to redo. */
export function redo(buf) {
  undoBoundary(buf);
  const g = buf.redoList.pop();
  if (!g) return false;
  buf.inUndo = true;
  try {
    for (const c of g.changes) apply(buf, c, false);
  } finally {
    buf.inUndo = false;
  }
  buf.undoList.push(g);
  buf.point.set(g.pointAfter ?? g.pointBefore);
  return true;
}
