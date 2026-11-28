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
import { viewMetrics, cursorClientRect } from './view.js';
import { defcommand } from './registry.js';
import { readClipboardText, readClipboardImage, imageFromBlob } from './clipboard.js';

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

/** Paste text where typing would go (insert state), or after the cursor in normal state. */
export function pasteText(text) {
  if (!text || helmActive()) return;
  text = text.replace(/\r\n?/g, '\n');
  if (currentBuffer()?.onTextInput) insertInput(text, { paste: true });
  else if (canInsert()) insertInput(text);
  else if (currentBuffer()) {
    // Outside insert state, paste after the cursor (or over a selection).
    callInteractively('vim-paste-from-clipboard', { args: [text] }).catch(reportError);
  }
}

/** Give an image ({ mimeType, data }) to the current buffer if it takes images (buffer.onPasteImage). */
export async function pasteImage(image) {
  const b = currentBuffer();
  if (!image || !b?.onPasteImage) return false;
  await b.onPasteImage(image);
  return true;
}

defcommand('clipboard-paste', {
  doc: 'Paste from the system clipboard (C-v in insert state, C-S-v; Cmd-V on macOS). Buffers that take images (agent prompts) get the clipboard\'s image when it holds no text.',
}, async () => {
  // Text wins: Office apps put a picture of copied text on the clipboard alongside it.
  const text = await readClipboardText();
  if (!text && currentBuffer()?.onPasteImage) {
    const image = await readClipboardImage();
    if (image) return pasteImage(image);
  }
  pasteText(text);
});

function positionInput() {
  if (!ta) return;
  const win = selectedWindow();
  const cursor = win?.cursorEl;
  if (!cursor || cursor.hidden) return;
  // Both rectangles come from measurements already made, so this doesn't lay out the page.
  const r = cursorClientRect(win);
  if (!r) return;
  frameOrigin ??= ta.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const left = `${r.left - frameOrigin.left}px`;
  const top = `${r.top - frameOrigin.top}px`;
  const height = `${viewMetrics().lh}px`;
  if (ta.style.left !== left) ta.style.left = left;
  if (ta.style.top !== top) ta.style.top = top;
  if (ta.style.height !== height) ta.style.height = height;
}

let frameOrigin = null; // where the input's positioning parent is (it only moves on resize)
window.addEventListener('resize', () => { frameOrigin = null; });

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
    if (helmActive()) return;
    const text = e.clipboardData?.getData('text/plain');
    const image = !text && [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (image && currentBuffer()?.onPasteImage) {
      imageFromBlob(image).then(pasteImage).catch(reportError);
      return;
    }
    pasteText(text);
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

