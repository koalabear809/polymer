// Saving state between sessions (like Emacs's savehist + recentf).
//
// Variables named in savehist-variables and all helm history lists are written to
// <config>/var/state.json when they change (checked every few seconds) and before quitting.

import { defvar, getVarOr, setq, boundp } from './registry.js';
import { readTextFile, writeTextFile, makeDirectory, pathInfo } from './files.js';
import { helmHistories, restoreHelmHistories } from './helm/helm.js';
import { configDirectory } from './loader.js';

defvar('savehist-variables', ['recentf-list', 'extended-command-history', 'chosen-theme', 'update-skipped-version'], {
  doc: 'Variables saved between sessions (their values must be JSON-serializable).',
});
defvar('savehist-interval', 5000, { doc: 'How often (ms) to check whether saved state changed.' });

let lastSaved = null;
let timer = null;

const statePath = () => (configDirectory() ? `${configDirectory()}var/state.json` : null);

function snapshot() {
  const vars = {};
  for (const name of getVarOr('savehist-variables', [], null)) {
    if (boundp(name)) vars[name] = getVarOr(name, null, null);
  }
  return JSON.stringify({ version: 1, variables: vars, histories: helmHistories() });
}

/** Load saved state. Saved values replace defaults; call after init.js so it can add variables. */
export async function restoreState() {
  const path = statePath();
  if (!path || !(await pathInfo(path)).isFile) return;
  try {
    const data = JSON.parse((await readTextFile(path)).text);
    for (const [name, value] of Object.entries(data.variables ?? {})) setq(name, value, null);
    restoreHelmHistories(data.histories);
  } catch (e) {
    console.warn('polymer: could not read saved state:', e);
  }
  lastSaved = snapshot();
}

/** Write state if it changed since the last save. */
export async function saveState() {
  const path = statePath();
  if (!path) return;
  const data = snapshot();
  if (data === lastSaved) return;
  await makeDirectory(`${configDirectory()}var/`);
  await writeTextFile(path, data, false);
  lastSaved = data;
}

export function startStateSaving() {
  clearInterval(timer);
  timer = setInterval(() => saveState().catch((e) => console.warn('polymer: saving state failed:', e)), getVarOr('savehist-interval', 5000, null));
}
