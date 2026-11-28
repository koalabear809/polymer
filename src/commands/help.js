// Self-documentation: describe-function, describe-variable, describe-key, describe-mode.

import {
  defcommand, allFunctions, functionInfo, allVariables, variableInfo, adviceList,
} from '../core/registry.js';
import { whereIs } from '../core/keymap.js';
import { keysToString } from '../core/keys.js';
import { readKeySequence } from '../core/command-loop.js';
import { completingRead } from '../core/helm/helm.js';
import { getBufferCreate, currentBuffer } from '../core/buffer.js';
import { setMajorMode, majorModeInfo, minorModeInfo, modeChain } from '../core/modes.js';
import { displayBuffer } from '../core/window.js';
import { prin1 } from '../core/printer.js';
import { message } from '../core/echo.js';
import { firstLine } from './builtins.js';

/** Show text in the *Help* buffer. */
export function showHelp(text) {
  const b = getBufferCreate('*Help*');
  if (b.mode !== 'help-mode') setMajorMode(b, 'help-mode');
  b.setText(text);
  displayBuffer(b, { otherWindow: true });
  return b;
}

function bindingsText(name) {
  const w = whereIs(name);
  if (!w.length) return `${name} is not bound to any keys.`;
  const items = w.slice(0, 12).map((b) => {
    const where = b.keymap === 'global' ? '' : ` in ${b.keymap}`;
    const state = b.state === '*' ? '' : ` (${b.state})`;
    return `  ${keysToString(b.keys)}${where}${state}`;
  });
  return `It is bound to:\n${items.join('\n')}`;
}

/** Functions on the scripting API (the `polymer` global) that aren't registry functions. */
function apiFunctionNames() {
  const api = globalThis.polymer ?? {};
  return Object.keys(api).filter((n) => typeof api[n] === 'function' && !functionInfo(n));
}

/** Candidates for describe-function: registry functions plus API functions. */
function functionCandidates(pred) {
  const reg = allFunctions(pred).map((f) => ({ label: f.name, value: f.name, annotation: firstLine(f.doc) }));
  const api = apiFunctionNames().map((n) => ({ label: n, value: n, annotation: 'API function' }));
  return [...reg, ...api].sort((a, b) => a.label.localeCompare(b.label));
}

function describeApiFunctionText(name, fn) {
  return [
    `${name} is a Polymer API function (also polymer.${name}).`,
    '',
    'Call it from init.js, packages or eval-expression. Source:',
    '',
    fn.toString(),
  ].join('\n');
}

export function describeFunctionText(name) {
  const f = functionInfo(name);
  if (!f) {
    const fn = globalThis.polymer?.[name];
    if (typeof fn === 'function') return describeApiFunctionText(name, fn);
    return `${name} is not defined.`;
  }
  const lines = [];
  lines.push(`${name} is ${f.command ? 'an interactive command' : 'a function'}.`);
  lines.push('');
  if (f.command) { lines.push(bindingsText(name)); lines.push(''); }
  lines.push(f.doc || 'Not documented.');
  const ads = adviceList(name);
  if (ads.length) {
    lines.push('');
    lines.push('Advice:');
    for (const a of ads) lines.push(`  ${a.how}: ${typeof a.fn === 'string' ? a.fn : a.id?.toString?.() ?? 'λ'}`);
  }
  if (f.mcp) { lines.push(''); lines.push('Exposed to agents over MCP.'); }
  lines.push('');
  lines.push(`Defined ${new Date(f.definedAt).toLocaleTimeString()}. Source:`);
  lines.push('');
  lines.push(f.fn.toString());
  return lines.join('\n');
}

export function describeVariableText(name, buf = currentBuffer()) {
  const v = variableInfo(name);
  if (!v) return `${name} is void as a variable.`;
  const lines = [];
  const local = buf?.locals?.has(name);
  lines.push(`${name}'s value is ${prin1(local ? buf.locals.get(name) : v.value, 3)}`);
  if (local) {
    lines.push(`  (local in buffer ${buf.name}; global value is ${prin1(v.value, 2)})`);
  }
  if (v.local) lines.push('  Automatically becomes buffer-local when set.');
  if (v.watchers.length) lines.push(`  Watched by ${v.watchers.length} function(s).`);
  lines.push('');
  lines.push(v.doc || 'Not documented.');
  return lines.join('\n');
}

defcommand('describe-function', {
  doc: 'Show the documentation, key bindings and source of a function, including Polymer API functions.',
  interactive: async () => [await completingRead('Describe function: ',
    functionCandidates(),
    { history: 'describe-function-history', preview: (n) => showHelp(describeFunctionText(n)) })],
}, (name) => showHelp(describeFunctionText(name)));

defcommand('describe-command', {
  doc: 'Like describe-function, limited to interactive commands.',
  interactive: async () => [await completingRead('Describe command: ',
    allFunctions((f) => f.command).map((f) => ({ label: f.name, value: f.name, annotation: firstLine(f.doc) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { history: 'describe-function-history', preview: (n) => showHelp(describeFunctionText(n)) })],
}, (name) => showHelp(describeFunctionText(name)));

defcommand('describe-variable', {
  doc: 'Show the value and documentation of a variable.',
  interactive: async () => [await completingRead('Describe variable: ',
    allVariables().map((v) => ({ label: v.name, value: v.name, annotation: firstLine(v.doc) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { history: 'describe-variable-history', preview: (n) => showHelp(describeVariableText(n)) })],
}, (name) => showHelp(describeVariableText(name)));

defcommand('describe-key', { doc: 'Read a key sequence and describe the command it runs.' }, async () => {
  const { keys, cmd } = await readKeySequence('Describe key: ');
  const k = keysToString(keys);
  if (cmd === null) return message('%s is undefined', k);
  if (typeof cmd === 'function') return showHelp(`${k} runs an anonymous function:\n\n${cmd.toString()}`);
  showHelp(`${k} runs the command ${cmd}.\n\n${describeFunctionText(cmd)}`);
});

defcommand('describe-mode', { doc: 'Describe the current major mode and enabled minor modes.' }, () => {
  const b = currentBuffer();
  const lines = [];
  const chain = modeChain(b.mode);
  lines.push(`${b.mode}${chain.length > 1 ? ` (derived from ${chain.slice(1).map((m) => m.name).join(' → ')})` : ''}`);
  lines.push('');
  lines.push(majorModeInfo(b.mode)?.doc || 'Not documented.');
  if (b.minorModes.size) {
    lines.push('');
    lines.push('Enabled minor modes:');
    for (const m of b.minorModes) lines.push(`  ${m}: ${firstLine(minorModeInfo(m)?.doc)}`);
  }
  lines.push('');
  lines.push(`Vim state: ${b.state}`);
  showHelp(lines.join('\n'));
});

