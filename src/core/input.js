// Text input for buffers.
//
// A hidden <textarea> keeps keyboard focus while no helm session is active. Key events
// go to the command loop first; keys that aren't bound and would type text are allowed
// through, arrive here as input, and are inserted with self-insert-command.
//
// The textarea follows the cursor so IME candidate windows appear in the right place,
// and becomes visible while composing to show the pre-edit text.

import { callInteractively, reportError } from './command-loop.js';
import { currentBuffer } from './buffer.js';
import { selectedWindow } from './window.js';
import { setFocusTarget, focusInput } from './focus.js';
import { onRedisplay } from './redisplay.js';
import { helmActive } from './helm/helm.js';
import { viewMetrics } from './view.js';

let ta = null;
let composing = false;

function canInsert() {
  if (helmActive()) return false;
  const b = currentBuffer();
  return !!b && (b.state === 'insert' || b.state === 'replace');
}

async function insertInput(text, { paste = false } = {}) {
  if (!text) return;
  // Buffers can take text themselves (a terminal sends it to the program).
  const b = currentBuffer();
  if (b?.onTextInput && !helmActive()) {
    try { await b.onTextInput(text, { paste }); } catch (e) { reportError(e); }
    return;
  }
  if (!canInsert()) return;
  try {
    await callInteractively('self-insert-command', { args: [text] });
  } catch (e) {
    reportError(e);
  }
}

function positionInput() {
  if (!ta) return;
  const win = selectedWindow();
  const cursor = win?.cursorEl;
  if (!cursor || cursor.hidden) return;
  const r = cursor.getBoundingClientRect();
  const frame = ta.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
  ta.style.left = `${r.left - frame.left}px`;
  ta.style.top = `${r.top - frame.top}px`;
  ta.style.height = `${viewMetrics().lh}px`;
}

export function attachInput(el) {
  ta = el;
  setFocusTarget(ta);

  ta.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
    const text = ta.value;
    ta.value = '';
    insertInput(text);
  });

  ta.addEventListener('compositionstart', () => {
    composing = true;
    ta.classList.add('composing');
  });
  ta.addEventListener('compositionupdate', (e) => {
    ta.style.width = `${Math.max(1, (e.data ?? '').length + 1) * viewMetrics().cw * 2}px`;
  });
  ta.addEventListener('compositionend', (e) => {
    composing = false;
    ta.classList.remove('composing');
    ta.style.width = '';
    // Engines differ in whether an input event follows; take the committed text here.
    const text = e.data || ta.value;
    ta.value = '';
    insertInput(text);
  });

  ta.addEventListener('paste', (e) => {
    e.preventDefault();
    let text = e.clipboardData?.getData('text/plain');
    if (!text || helmActive()) return;
    text = text.replace(/\r\n?/g, '\n');
    if (currentBuffer()?.onTextInput) insertInput(text, { paste: true });
    else if (canInsert()) insertInput(text);
    else if (currentBuffer()) {
      // Cmd-V outside insert state pastes after the cursor (or over a selection).
      callInteractively('vim-paste-from-clipboard', { args: [text] }).catch(reportError);
    }
  });

  // Keep focus here unless something else (helm) deliberately takes it.
  ta.addEventListener('blur', () => {
    setTimeout(() => {
      if (!helmActive() && document.activeElement === document.body) focusInput();
    }, 0);
  });

  onRedisplay(positionInput);
  focusInput();
}

