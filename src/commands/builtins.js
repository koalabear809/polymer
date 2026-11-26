// Built-in commands: M-x, eval, buffers, windows, scrolling.

import { defcommand, defvar, setq, getVarOr, allFunctions, functionInfo, call } from '../core/registry.js';
import { callInteractively } from '../core/command-loop.js';
import { whereIs } from '../core/keymap.js';
import { keysToString } from '../core/keys.js';
import { helm, completingRead, readString, yesOrNo } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { evalString } from '../core/eval.js';
import { prin1 } from '../core/printer.js';
import {
  bufferList, getBuffer, getBufferCreate, currentBuffer, killBufferInternal,
} from '../core/buffer.js';
import { setMajorMode, majorModeInfo } from '../core/modes.js';
import {
  selectedWindow, setWindowBuffer, displayBuffer, splitWindow, deleteWindow,
  deleteOtherWindows, otherWindow, windowInDirection, selectWindow, balanceWindows,
  switchToPrevBuffer, replaceBufferInWindows, scrollWindow, windowBodyLines, scrollToEdge,
  windowList,
} from '../core/window.js';
import { PolymerError } from '../core/errors.js';
import { appInfo } from '../core/host.js';
import { evalModule, describeLoadError } from '../core/loader.js';

// ---------------------------------------------------------------------------
// M-x

defvar('extended-command-history', [], { doc: 'Recently run M-x commands, most recent first.' });

/** Short description of the keys bound to a command, for annotations. */
export function bindingHint(name) {
  const w = whereIs(name);
  if (!w.length) return '';
  return keysToString(w[0].keys);
}

export const firstLine = (s) => (s ?? '').split('\n')[0];

defcommand('execute-extended-command', { doc: 'Read a command name with helm and run it.' }, async () => {
  const history = getVarOr('extended-command-history', []);
  const commands = allFunctions((f) => f.command).map((f) => f.name);
  const rank = new Map(history.map((n, i) => [n, i]));
  commands.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b));
  const choice = await helm({
    prompt: 'M-x ',
    sources: [{
      name: 'Commands',
      candidates: commands.map((n) => {
        const keys = bindingHint(n);
        const doc = firstLine(functionInfo(n)?.doc);
        return { label: n, value: n, annotation: [keys && `(${keys})`, doc].filter(Boolean).join('  ') };
      }),
      actions: {
        Execute: (n) => ({ run: n }),
        Describe: (n) => ({ describe: n }),
      },
    }],
  });
  if (choice?.describe) return call('describe-function', choice.describe);
  const name = choice?.run;
  if (typeof name !== 'string') return;
  setq('extended-command-history', [name, ...history.filter((h) => h !== name)].slice(0, 100), null);
  return callInteractively(name);
});

defcommand('keyboard-quit', { doc: 'Cancel the current operation.' }, () => message('Quit'));

// ---------------------------------------------------------------------------
// Evaluation

defvar('eval-last-value', undefined, { doc: 'The value of the last eval-expression.' });

defcommand('eval-expression', {
  doc: 'Read a JavaScript expression (or statements), evaluate it, and show the result.\nThe value is stored in the variable eval-last-value.',
  interactive: async () => [await readString('Eval: ', { history: 'eval-expression-history' })],
}, async (code) => {
  if (!code?.trim()) return;
  const value = await evalString(code);
  setq('eval-last-value', value, null);
  message('%s', prin1(value));
  return value;
});

defcommand('eval-buffer', { doc: 'Evaluate the current buffer as JavaScript. File buffers run as modules (require, __dirname, ...).' }, async () => {
  const b = currentBuffer();
  let value;
  if (b.file) {
    try {
      value = await evalModule(b.getText(), b.file);
    } catch (e) {
      throw new PolymerError('load-error', describeLoadError(e, b.file));
    }
  } else {
    value = await evalString(b.getText(), { filename: b.name });
  }
  setq('eval-last-value', value, null);
  message('Evaluated %s%s', b.name, value === undefined ? '' : ` => ${prin1(value)}`);
  return value;
});

defcommand('eval-line', { doc: 'Evaluate the current line as JavaScript and show the result.' }, async () => {
  const b = currentBuffer();
  const code = b.lineText(b.lineAt());
  if (!code.trim()) return;
  const value = await evalString(code);
  setq('eval-last-value', value, null);
  message('%s', prin1(value));
  return value;
});

// ---------------------------------------------------------------------------
// Buffers

function ensureScratch() {
  let b = getBuffer('*scratch*');
  if (!b) {
    b = getBufferCreate('*scratch*');
    setMajorMode(b, 'scratch-mode');
  }
  return b;
}

export function killBuffer(nameOrBuffer) {
  const b = getBuffer(nameOrBuffer);
  if (!b) throw new PolymerError('error', `No such buffer: ${nameOrBuffer}`);
  if (bufferList({ all: true }).length === 1) ensureScratch(); // never leave zero buffers
  if (b.name === '*scratch*' && bufferList().length === 1) return false;
  replaceBufferInWindows(b);
  return killBufferInternal(b);
}

function bufferCandidate(b) {
  const mode = majorModeInfo(b.mode)?.lighter ?? b.mode;
  const shown = windowList().some((w) => w.buffer === b) ? 'shown' : '';
  return { label: b.name, value: b.name, annotation: [mode, shown].filter(Boolean).join('  ') };
}

defcommand('switch-to-buffer', { doc: 'Switch to a buffer chosen with helm, or create a new one.' }, async () => {
  const cur = currentBuffer();
  // Put the current buffer last so RET on an empty query goes to the previous buffer.
  const bufs = [...bufferList().filter((b) => b !== cur), ...(cur ? [cur] : [])];
  return helm({
    prompt: 'Switch to buffer: ',
    history: 'buffer-name-history',
    sources: [
      {
        name: 'Buffers',
        candidates: bufs.map(bufferCandidate),
        actions: {
          'Switch to buffer': (n) => setWindowBuffer(selectedWindow(), n),
          'Switch to buffer in other window': (n) => displayBuffer(n, { otherWindow: true }),
          'Kill buffer': (n) => killBufferAsking(n),
        },
        preview: (n) => setWindowBuffer(selectedWindow(), n),
      },
      {
        name: 'Create buffer',
        dummy: true,
        actions: { 'Create buffer': (n) => setWindowBuffer(selectedWindow(), getBufferCreate(n)) },
      },
    ],
  });
});

/** Kill a buffer, asking first if it has unsaved changes to a file. */
export async function killBufferAsking(nameOrBuffer) {
  const b = getBuffer(nameOrBuffer);
  if (b?.file && b.modified && !(await yesOrNo(`Buffer ${b.name} modified; kill anyway?`))) return false;
  return killBuffer(b ?? nameOrBuffer);
}

defcommand('kill-buffer', {
  doc: 'Kill a buffer chosen with helm (default: the current buffer).',
  interactive: async () => {
    const cur = currentBuffer();
    const names = [cur, ...bufferList().filter((b) => b !== cur)].filter(Boolean).map(bufferCandidate);
    return [await completingRead('Kill buffer: ', names)];
  },
}, (name) => killBufferAsking(name ?? currentBuffer()));

defcommand('kill-current-buffer', { doc: 'Kill the current buffer.' }, () => killBufferAsking(currentBuffer()));

defcommand('previous-buffer', { doc: 'Show the previous buffer in the selected window.' }, () => {
  if (!switchToPrevBuffer(selectedWindow())) message('No previous buffer');
});

defcommand('next-buffer', { doc: 'Show the least recently used buffer in the selected window.' }, () => {
  const cur = currentBuffer();
  const list = bufferList().filter((b) => b !== cur);
  if (!list.length) return message('No next buffer');
  setWindowBuffer(selectedWindow(), list.at(-1));
});

defcommand('switch-to-scratch-buffer', { doc: 'Switch to *scratch*.' }, () => setWindowBuffer(selectedWindow(), ensureScratch()));

defcommand('view-echo-area-messages', { doc: 'Show the *Messages* buffer.' }, () => {
  displayBuffer(getBufferCreate('*Messages*'), { otherWindow: true });
});

// ---------------------------------------------------------------------------
// Windows

defcommand('split-window-below', { doc: 'Split the selected window into two, one above the other.' }, () => splitWindow(selectedWindow(), 'below'));
defcommand('split-window-right', { doc: 'Split the selected window into two side by side.' }, () => splitWindow(selectedWindow(), 'right'));
defcommand('split-window-below-and-focus', { doc: 'Split below and select the new window.' }, () => selectWindow(splitWindow(selectedWindow(), 'below')));
defcommand('split-window-right-and-focus', { doc: 'Split right and select the new window.' }, () => selectWindow(splitWindow(selectedWindow(), 'right')));
defcommand('delete-window', { doc: 'Delete the selected window.' }, () => deleteWindow(selectedWindow()));
defcommand('delete-other-windows', { doc: 'Make the selected window fill the frame.' }, () => deleteOtherWindows(selectedWindow()));
defcommand('other-window', { doc: 'Select the next window.' }, () => otherWindow(1));
defcommand('balance-windows', { doc: 'Make all windows the same size.' }, () => balanceWindows());

for (const dir of ['left', 'right', 'up', 'down']) {
  defcommand(`windmove-${dir}`, { doc: `Select the window ${dir === 'up' || dir === 'down' ? (dir === 'up' ? 'above' : 'below') : `to the ${dir}`}.` }, () => {
    const w = windowInDirection(dir);
    if (!w) return message(`No window ${dir} from selected window`);
    selectWindow(w);
  });
}

defcommand('quit-window', { doc: 'Quit the selected window: delete it if it was made for this buffer, else show the previous buffer.' }, () => {
  const w = selectedWindow();
  if (w.quitRestore === 'delete' && windowList().length > 1) {
    deleteWindow(w);
  } else {
    switchToPrevBuffer(w, { bury: true });
  }
});

// ---------------------------------------------------------------------------
// Scrolling (phase 0 buffers are read-only; these become cursor motions with the editor core)

defcommand('scroll-line-down', { doc: 'Scroll the text up one line.' }, () => scrollWindow(1));
defcommand('scroll-line-up', { doc: 'Scroll the text down one line.' }, () => scrollWindow(-1));
defcommand('scroll-half-page-down', { doc: 'Scroll down half a window.' }, () => scrollWindow(Math.ceil(windowBodyLines() / 2)));
defcommand('scroll-half-page-up', { doc: 'Scroll up half a window.' }, () => scrollWindow(-Math.ceil(windowBodyLines() / 2)));
defcommand('scroll-page-down', { doc: 'Scroll down one window.' }, () => scrollWindow(windowBodyLines() - 2));
defcommand('scroll-page-up', { doc: 'Scroll up one window.' }, () => scrollWindow(-(windowBodyLines() - 2)));
defcommand('scroll-to-top', { doc: 'Scroll to the start of the buffer.' }, () => scrollToEdge('top'));
defcommand('scroll-to-bottom', { doc: 'Scroll to the end of the buffer.' }, () => scrollToEdge('bottom'));

// ---------------------------------------------------------------------------
// Misc

defcommand('reload-polymer', { doc: 'Reload the webview: re-evaluates all frontend code (like restarting the Lisp image).' }, () => location.reload());

defcommand('toggle-debug-on-error', { doc: 'Toggle logging full stack traces for command errors.' }, () => {
  const v = !getVarOr('debug-on-error', false);
  setq('debug-on-error', v, null);
  message('debug-on-error %s', v ? 'enabled' : 'disabled');
});

defcommand('polymer-version', { doc: 'Show the Polymer version and platform.' }, async () => {
  const i = await appInfo();
  message('Polymer %s on %s (config: %s)', i.version, i.platform, i.configDir ?? 'n/a');
});
