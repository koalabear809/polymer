// Updates. Polymer checks GitHub Releases for a newer signed build (the updater plugin
// verifies the signature against the public key in tauri.conf.json), offers it, and
// installs it.
//
//   M-x check-for-updates   (SPC h u)   check now and say if you're up to date
//   update-check-on-startup             check quietly a few seconds after starting

import { defcommand, defvar, getVarOr, setq, runHooksAsync } from '../core/registry.js';
import { completingRead } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { isTauri, appInfo } from '../core/host.js';
import { bufferList } from '../core/buffer.js';
import { saveState } from '../core/persist.js';

defvar('update-check-on-startup', true, { doc: 'Check GitHub Releases for a new version a few seconds after starting.' });
defvar('update-check-delay', 8000, { doc: 'Milliseconds to wait after startup before the automatic check.' });
defvar('update-skipped-version', null, { doc: 'A version you chose to skip; automatic checks stop offering it (a manual check still does).' });

const userError = (msg) => new PolymerError('user-error', msg);
let busy = false;

const plugins = () => {
  const t = globalThis.__TAURI__;
  if (!t?.updater || !t?.process) throw userError('Updates are only available in the installed app');
  return t;
};

const unsavedBuffers = () => bufferList({ all: true }).filter((b) => b.file && b.modified);

function showNotes(update) {
  return import('../commands/help.js').then(({ showHelp }) => showHelp(
    `Polymer ${update.version}  (you have ${update.currentVersion})\n${update.date ? `Released ${update.date}\n` : ''}\n${(update.body ?? '').trim() || 'No release notes.'}`,
  ));
}

async function install(update) {
  const dirty = unsavedBuffers();
  if (dirty.length) {
    throw userError(`Save ${dirty.length === 1 ? dirty[0].name : `${dirty.length} modified buffers`} first (SPC f s); Polymer restarts to update. Then run M-x check-for-updates.`);
  }
  let total = 0;
  let done = 0;
  message('Downloading Polymer %s…', update.version);
  await update.downloadAndInstall((ev) => {
    if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
    else if (ev.event === 'Progress') {
      done += ev.data.chunkLength;
      message('Downloading Polymer %s… %s', update.version, total ? `${Math.round((done / total) * 100)}%` : `${Math.round(done / 1024)} KB`);
    } else if (ev.event === 'Finished') message('Installing Polymer %s…', update.version);
  });
  // Keep the session (perspectives) and saved state; a restart should feel like a reload.
  await runHooksAsync('kill-polymer-hook');
  await saveState().catch(() => {});
  message('Restarting…');
  await plugins().process.relaunch();
}

/**
 * Check for a new version. `manual`: say so when up to date or on errors, and offer a
 * version even if you skipped it. Resolves to the Update if one was found.
 */
export async function checkForUpdates({ manual = false } = {}) {
  if (busy) return null;
  busy = true;
  try {
    const t = plugins();
    if (manual) message('Checking for updates…');
    let update;
    try {
      update = await t.updater.check();
    } catch (e) {
      // Offline, rate limited, no release yet, ...: say so when asked, stay quiet at startup.
      if (manual) throw userError(`Update check failed: ${e?.message ?? e}`);
      console.warn('update check failed:', e);
      return null;
    }
    if (!update) {
      if (manual) message('Polymer %s is up to date', (await appInfo()).version);
      return null;
    }
    if (!manual && getVarOr('update-skipped-version', null, null) === update.version) return update;
    for (;;) {
      const choice = await completingRead(`Polymer ${update.version} is available (you have ${update.currentVersion}): `, [
        { label: 'Install now and restart', value: 'install', annotation: 'downloads, saves your session, relaunches' },
        { label: 'View release notes', value: 'notes' },
        { label: 'Remind me later', value: 'later', annotation: 'asks again at the next start' },
        { label: 'Skip this version', value: 'skip', annotation: 'until a newer one is released' },
      ], { sourceName: 'Update' }).catch(() => 'later');
      if (choice === 'notes') { await showNotes(update); continue; }
      if (choice === 'install') await install(update);
      else if (choice === 'skip') { setq('update-skipped-version', update.version, null); message('Skipping %s', update.version); }
      break;
    }
    return update;
  } finally {
    busy = false;
  }
}

defcommand('check-for-updates', { doc: 'Check GitHub Releases for a new version of Polymer (SPC h u).' }, () => checkForUpdates({ manual: true }));

/** Schedule the quiet startup check. */
export function scheduleStartupUpdateCheck() {
  if (!isTauri || !getVarOr('update-check-on-startup', true, null)) return;
  // Problems after you choose to install (unsaved files, a failed download) are reported.
  setTimeout(() => checkForUpdates().catch((e) => message('%s', e?.message ?? e)), getVarOr('update-check-delay', 8000, null));
}
