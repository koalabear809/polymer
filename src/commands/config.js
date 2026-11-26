// Configuration: init.js and packages.

import { defcommand, getVarOr, setq, runHooksAsync } from '../core/registry.js';
import { helm, readString } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { findBufferVisiting } from '../core/buffer.js';
import { selectedWindow, setWindowBuffer } from '../core/window.js';
import { pathInfo, makeDirectory, writeTextFile, abbreviateFileName } from '../core/files.js';
import {
  loadFile, describeLoadError, listPackages, reloadPackage, configDirectory, require,
} from '../core/loader.js';
import { openFile, helmFindFiles, readFileName } from './files.js';

const userError = (msg) => new PolymerError('user-error', msg);

function requireConfigDir() {
  const dir = configDirectory();
  if (!dir) throw userError('No config directory (not running in the app?)');
  return dir;
}

// ---------------------------------------------------------------------------
// init.js

export function initTemplate(dir) {
  const short = abbreviateFileName(dir);
  return `// Polymer init file (${short}init.js).
//
// Evaluated at startup after the built-in commands and keys. Re-run it with
// SPC h r r (reload-init-file): defvar, addHook, advice and defineKey are safe to re-run.
// Everything here can also be tried in *scratch* or with M-: first.
// Describe anything with SPC h f (functions), SPC h v (variables), SPC h k (keys).

// ---------------------------------------------------------------------------
// Settings

// setq('tab-width', 2)
// setq('display-line-numbers', true)        // absolute numbers ('relative' is the default)
// setq('scroll-margin', 5)
// setq('vim-want-Y-yank-to-eol', false)

// ---------------------------------------------------------------------------
// Keys (general.el style)

// defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
//   'o': { label: 'open' },
//   'o s': 'switch-to-scratch-buffer',
// })

// ---------------------------------------------------------------------------
// Commands

// defcommand('insert-date', { doc: 'Insert today\\'s date.' }, () => {
//   currentBuffer().insert(new Date().toISOString().slice(0, 10))
// })

// ---------------------------------------------------------------------------
// Hooks and advice

// addHook('after-save-hook', function announceSave(buf) { message('Saved %s', buf.name) })

// ---------------------------------------------------------------------------
// Packages
//
// Packages live in ${short}packages/<name>/ (index.js, plus an optional package.json).
// Make one with M-x create-package, then load it here:
//
// await usePackage('my-package', {
//   config() { setq('my-package-greeting', 'Hi') },
// })
`;
}

defcommand('find-init-file', { doc: 'Open init.js (starting from a template if it does not exist yet).' }, async () => {
  const dir = requireConfigDir();
  const path = `${dir}init.js`;
  const existing = findBufferVisiting(path);
  if (existing) return setWindowBuffer(selectedWindow(), existing);
  const buf = await openFile(path);
  if (!(await pathInfo(path)).exists && buf.length === 0) {
    buf.setText(initTemplate(dir));
    buf.modified = true;
    message('New init.js from a template; save it with SPC f s');
  }
  return buf;
});

/** Load init.js. Returns true on success; errors are reported, not thrown. */
export async function loadInitFile() {
  const path = getVarOr('user-init-file', null, null);
  if (!path) return false;
  if (!(await pathInfo(path)).isFile) return false;
  const t0 = performance.now();
  try {
    await loadFile(path);
    setq('init-file-loaded', true, null);
    await runHooksAsync('after-init-file-hook', path);
    message('Loaded %s in %dms', abbreviateFileName(path), Math.round(performance.now() - t0));
    return true;
  } catch (e) {
    message('Error in init file: %s', describeLoadError(e, path));
    console.error(e);
    return false;
  }
}

defcommand('reload-init-file', { doc: 'Evaluate init.js again.' }, async () => {
  const path = getVarOr('user-init-file', null, null);
  if (!path || !(await pathInfo(path)).isFile) throw userError('No init.js yet; create one with find-init-file');
  return loadInitFile();
});

defcommand('load-file', {
  doc: 'Evaluate a JavaScript file (with module, require, load, __dirname in scope).',
  interactive: async () => [await readFileName('Load file: ')],
}, async (path) => {
  try {
    await loadFile(path);
    message('Loaded %s', abbreviateFileName(path));
  } catch (e) {
    throw new PolymerError('load-error', describeLoadError(e, path));
  }
});

defcommand('open-config-directory', { doc: 'Browse the config directory with find-file.' }, () => {
  const dir = requireConfigDir();
  return helmFindFiles({
    initial: abbreviateFileName(dir),
    actions: { 'Find file': (p) => openFile(p) },
    newActions: { 'Create file': (p) => openFile(p) },
  });
});

// ---------------------------------------------------------------------------
// Packages

defcommand('list-packages', { doc: 'Browse packages on load-path: load, reload or open them.' }, async () => {
  const pkgs = await listPackages();
  if (!pkgs.length) {
    message('No packages yet in %s; make one with M-x create-package', abbreviateFileName(`${requireConfigDir()}packages/`));
    return;
  }
  return helm({
    prompt: 'Package: ',
    sources: [{
      name: 'Packages',
      candidates: pkgs.map((p) => ({
        label: p.name,
        value: p,
        annotation: [p.loaded ? 'loaded' : '', p.version, p.description].filter(Boolean).join('  '),
      })),
      actions: {
        'Load (or reload)': async (p) => {
          await (p.loaded ? reloadPackage(p.name) : require(p.name));
          message('Loaded package %s', p.name);
        },
        'Open package directory': (p) => helmFindFiles({
          initial: abbreviateFileName(p.dir),
          actions: { 'Find file': (f) => openFile(f) },
          newActions: { 'Create file': (f) => openFile(f) },
        }),
      },
    }],
  });
});

defcommand('reload-package', {
  doc: 'Load a package again after editing it.',
  interactive: async () => {
    const pkgs = (await listPackages()).filter((p) => p.loaded);
    if (!pkgs.length) throw userError('No packages loaded');
    return [await helm({ prompt: 'Reload package: ', sources: [{ name: 'Loaded packages', candidates: pkgs.map((p) => p.name) }] })];
  },
}, async (name) => {
  await reloadPackage(name);
  message('Reloaded package %s', name);
});

function packageIndexTemplate(name, description) {
  const id = name.replace(/[^\w-]/g, '-');
  return `// ${name}${description ? `: ${description}` : ''}
//
// Load it from init.js with:  await usePackage('${name}')   or   await require('${name}')
// In scope: module, exports, require, load, __dirname (this directory), __filename.
// packageDataDir('${name}') gives a directory for files this package wants to keep.

defvar('${id}-greeting', 'Hello', { doc: 'Greeting used by ${id}-hello.' })

defcommand('${id}-hello', { doc: 'Say hello from ${name}.' }, () => {
  message('%s from ${name}!', getVar('${id}-greeting'))
})

provide('${name}')
`;
}

defcommand('create-package', {
  doc: 'Create a new package in the packages directory and open its index.js.',
  interactive: async () => [await readString('New package name: '), await readString('Description (optional): ')],
}, async (name, description = '') => {
  name = (name ?? '').trim();
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) throw userError('Package names may contain letters, digits, ".", "_" and "-"');
  const dir = `${requireConfigDir()}packages/${name}/`;
  if ((await pathInfo(dir)).exists) throw userError(`${abbreviateFileName(dir)} already exists`);
  await makeDirectory(dir);
  const manifest = { name, version: '0.1.0', description: description.trim(), main: 'index.js', dependencies: [] };
  await writeTextFile(`${dir}package.json`, `${JSON.stringify(manifest, null, 2)}\n`, false);
  await writeTextFile(`${dir}index.js`, packageIndexTemplate(name, description.trim()), false);
  await openFile(`${dir}index.js`);
  message('Created %s. Evaluate it with SPC e b, or add usePackage(\'%s\') to init.js', abbreviateFileName(dir), name);
});

