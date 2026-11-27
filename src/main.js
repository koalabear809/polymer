// Boot: load the core, built-in commands and default keys, then build the frame.

import { installGlobals } from './core/api.js';
import { runHooks, setHookErrorReporter } from './core/registry.js';
import { attachEcho, message } from './core/echo.js';
import { attachWhichKey } from './core/which-key.js';
import { attachHelm } from './core/helm/helm.js';
import { attachInput } from './core/input.js';
import { installKeyHandler, reportError } from './core/command-loop.js';
import { getBufferCreate } from './core/buffer.js';
import { setMajorMode } from './core/modes.js';
import { initWindows } from './core/window.js';
import { initFiles } from './core/files.js';
import { initLoader } from './core/loader.js';
import { restoreState, startStateSaving } from './core/persist.js';
import { invalidateMetrics } from './core/view.js';
import { scheduleRedisplay, setRedisplayErrorReporter } from './core/redisplay.js';
import './commands/builtins.js';
import './commands/help.js';
import './commands/editing.js';
import './commands/files.js';
import './commands/dired.js';
import './commands/filetree.js';
import './commands/image.js';
import './commands/language-modes.js';
import { loadInitFile } from './commands/config.js';
import './vim/index.js';
import './syntax/index.js';
import { reattachTerminals } from './terminal/term.js';
import { restoreChosenTheme } from './themes/themes.js';
import { initPerspectives } from './persp/persp.js';
import './git/index.js';
import './agent/index.js';
import { killOrphanAgents } from './agent/agent.js';
import { startMcpServer } from './mcp/mcp.js';
import { scheduleStartupUpdateCheck } from './updates/updates.js';

const SCRATCH = `// Welcome to Polymer. This is *scratch*: JavaScript you can edit and evaluate.
//
//   Vim keys: i a o, h j k l, w b e, dw ciw yy p, v V C-v, / n, :s/a/b/g, :w, . u C-r
//   SPC f f        find a file (RET enters dirs, C-l goes up) SPC f s   save
//   SPC b b        switch buffer      SPC w v / SPC w s   split windows
//   M-x / SPC :    run a command      SPC h f / v / k     describe function/variable/key
//   SPC e l        evaluate the current line   SPC e b   evaluate the whole buffer
//
// Try it: put the cursor on the next line and press SPC e l, then M-x hello.

defcommand('hello', () => message('Hello from %s', currentBuffer().name))
`;

async function boot() {
  installGlobals();
  attachEcho(document.getElementById('echo'));
  attachWhichKey(document.getElementById('which-key'));
  attachHelm(document.getElementById('helm'));
  setHookErrorReporter((hook, e) => { e.message = `Error in ${hook}: ${e.message}`; reportError(e); });
  setRedisplayErrorReporter((e) => {
    e.message = `Redisplay error: ${e.message}`;
    reportError(e);
    if (!window.__polymerBooted) throw e; // shown by boot-errors.js
  });

  const messages = getBufferCreate('*Messages*');
  setMajorMode(messages, 'messages-buffer-mode');
  messages.point.insertionType = true; // follow new messages when point is at the end
  const scratch = getBufferCreate('*scratch*');
  setMajorMode(scratch, 'scratch-mode');
  scratch.setText(SCRATCH);
  scratch.modified = false;
  scratch.point.set(scratch.lineStart(scratch.lineCount - 2));

  initWindows(document.getElementById('windows'), scratch);
  initPerspectives();
  attachInput(document.getElementById('input'));
  installKeyHandler();

  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
  // Re-measure the character grid once web fonts have loaded.
  document.fonts?.ready.then(() => { invalidateMetrics(); scheduleRedisplay(); });

  window.__polymerBooted = true;
  message('Polymer ready. SPC for the leader key, M-x for commands.');

  // Files and the user's configuration. Each step reports its own failure so one broken
  // step (a bad init.js, a missing tool) doesn't stop the rest. Set POLYMER_NO_INIT=1
  // (or pass -q) to skip init.js entirely.
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { e.message = `${name}: ${e.message}`; reportError(e); }
  };
  await step('files', () => initFiles());
  await step('init', async () => {
    const { noInit } = await initLoader();
    if (noInit) message('Skipped init.js (POLYMER_NO_INIT / -q)');
    else await loadInitFile();
  });
  await step('saved state', async () => {
    await restoreState();
    restoreChosenTheme();
    startStateSaving();
  });
  await step('agents', () => killOrphanAgents()); // agent sessions don't survive a reload
  await step('MCP server', () => startMcpServer());
  // Shells keep running in the backend across reloads (SPC q r); pick them back up.
  await step('terminals', async () => {
    const n = await reattachTerminals();
    if (n) message('Re-attached %d terminal%s (SPC b t)', n, n === 1 ? '' : 's');
  });

  scheduleStartupUpdateCheck();
  runHooks('after-init-hook');
}

boot();
