// Agent buffers: chat with an ACP agent (Claude Code by default).
//
// The buffer is a transcript followed by a "❯ " prompt; text after the prompt is your
// next message (everything before it is read-only). RET sends (in insert state; S-RET or
// C-j for a newline), C-c C-k cancels, C-c m changes the mode. Mention files with @path.
//
// Agents are defined in agent-definitions; add your own ACP agent with defineAgent:
//   defineAgent('gemini', { label: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] })

import {
  defcommand, defvar, getVarOr, setq, addHook, runHooks, call,
} from '../core/registry.js';
import { defineMajorMode, setMajorMode } from '../core/modes.js';
import { defineKey } from '../core/keymap.js';
import { getBufferCreate, getBuffer, generateNewBufferName, currentBuffer, bufferList } from '../core/buffer.js';
import { Marker } from '../core/marker.js';
import { selectedWindow, setWindowBuffer, displayBuffer, windowList } from '../core/window.js';
import { completingRead } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError, Quit } from '../core/errors.js';
import { invoke, isTauri } from '../core/host.js';
import {
  expandFileName, abbreviateFileName, pathInfo, basename, asDirectory, makeDirectory, writeTextFile, listDirectory,
} from '../core/files.js';
import { AcpClient } from './acp.js';
import { viewMetrics } from '../core/view.js';
import { highlightSnippet } from '../syntax/treesit.js';
import { renderMarkdown } from './markdown.js';
import { imageMimeType } from '../commands/image.js';

defvar('agent-definitions', {
  'claude-code': { label: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
}, { doc: 'ACP agents: name -> { label, command, args, env }.' });
defvar('agent-default', 'claude-code', { doc: 'The agent started by SPC a a.' });
defvar('agent-env-remove', [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
], {
  doc: 'Environment variables removed from agent processes. Claude Code refuses to start when it sees it is inside another Claude Code session (CLAUDECODE), which happens if Polymer itself was launched from one.',
});
defvar('agent-mcp-servers', [], { doc: 'Extra MCP servers given to new agent sessions ([{ type: "http", name, url, headers }]).' });
defvar('agent-tool-output-lines', 12, { doc: 'Lines of tool output (diffs, terminal output) shown per tool call.' });
defvar('agent-save-transcripts', true, { doc: 'Save each conversation as Markdown in agent-transcript-directory under the agent\'s directory.' });
defvar('agent-transcript-directory', '.polymer/agent/', { doc: 'Where transcripts go, relative to the agent buffer\'s directory.' });
defvar('agent-transcript-save-delay', 2000, { doc: 'Milliseconds of quiet before a transcript is saved (it is also saved at the end of each turn).' });
defvar('agent-thought-level', 'full', { doc: 'How much of the agent\'s thinking text to display (a display filter only; the agent\'s real effort is set with select-effort): "none" (hide all thoughts), "summary" (show brief thoughts), or "full" (show all thoughts).' });
defvar('agent-models', {}, { doc: 'Extra model labels, merged over what the agent reports: { id: { label, description } }. Normally empty; the session\'s own model list is used.' });
defvar('agent-default-model', null, { doc: 'Model ID to switch new agent sessions to (nil keeps the agent\'s own default).' });
defvar('agent-wrap-column', 0, { doc: 'Hard-wrap agent text at this column so wrapped lines are real lines: "auto" (window width), a number, or 0 to disable (default; agent buffers soft-wrap and reflow on resize).' });
defvar('agent-render-markdown', true, { doc: 'Show the agent\'s Markdown formatted (markup hidden, lists as bullets, tables drawn as boxes) rather than as raw text with highlighting. Saved transcripts are always the raw Markdown.' });
defvar('agent-steer-presets', {
  concise: { label: 'Concise', prompt: 'Be extremely concise in your responses. Provide only essential information.' },
  verbose: { label: 'Verbose', prompt: 'Be detailed and thorough in your explanations. Include examples and context.' },
  teaching: { label: 'Teaching', prompt: 'Explain concepts in a teaching style. Break down complex ideas into simple steps.' },
  debugging: { label: 'Debugging', prompt: 'Focus on debugging and problem-solving. Analyze issues methodically.' },
  code: { label: 'Code-focused', prompt: 'Focus on writing clean, well-documented code. Prioritize code quality.' },
}, { doc: 'Preset steering prompts. Keys are preset IDs, values are { label, prompt }.' });
defvar('agent-thoughts-collapsed', false, { doc: 'Show thinking sections collapsed to one line by default (TAB on one toggles it; S-TAB toggles all).' });
defvar('agent-show-banner', true, { doc: 'Show the session header line at the top of agent windows (its contents: agent-header-fields).' });
defvar('agent-blank-line-height', 0.6, { doc: 'Height of blank lines between parts of the conversation, as a fraction of a line (1 = a full line).' });
defvar('agent-header-fields', ['model', 'effort', 'tokens', 'cost'], {
  doc: 'What the agent header line shows, in order. Fields: "model", "effort", "mode" (e.g. plan), "tokens" (input/output this session), "context" (tokens in the context window / its size), "cost" (the session\'s total, as the agent reports it).',
});
defvar('agent-token-costs', {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.25, output: 1.25 },
}, { doc: 'Token costs per million tokens: { model: { input: cost, output: cost } }. Costs in USD.' });

const userError = (msg) => new PolymerError('user-error', msg);
const PROMPT = '❯ ';

/** Lines of text with leading/trailing blank lines dropped and runs of blank lines collapsed to one. */
function tidyLines(text) {
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) { if (out.length && out.at(-1) !== '') out.push(''); } else out.push(l.replace(/\s+$/, ''));
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

export function defineAgent(name, def) {
  setq('agent-definitions', { ...getVarOr('agent-definitions', {}, null), [name]: def }, null);
  return name;
}

defineMajorMode('agent-mode', {
  doc: 'Chat with an ACP agent. Type after ❯ and press RET (normal state) or C-c C-c to send; RET in insert state adds newline; C-c C-k cancels; C-c m sets the mode; RET on a tool line opens its file.',
  lighter: 'Agent',
});

// Functions that contribute MCP servers to new sessions (Phase 7's editor server uses this).
const mcpProviders = [];
export function addAgentMcpProvider(fn) { if (!mcpProviders.includes(fn)) mcpProviders.push(fn); }

async function mcpServersFor(b) {
  const servers = [...getVarOr('agent-mcp-servers', [], null)];
  for (const p of mcpProviders) {
    try {
      const s = await p(b);
      if (s) servers.push(...[].concat(s));
    } catch (e) {
      console.warn('MCP provider failed:', e);
    }
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Transcript model -> text

const STATUS_ICON = { pending: '…', in_progress: '⟳', completed: '✓', failed: '✗' };
const PLAN_ICON = { pending: '○', in_progress: '⟳', completed: '✓' };

function blockText(content) {
  if (!content) return '';
  if (content.type === 'text') return content.text ?? '';
  if (content.type === 'resource_link') return `[${content.name ?? content.uri}]`;
  if (content.type === 'resource') return content.resource?.text ?? `[${content.resource?.uri}]`;
  if (content.type === 'image') return '[image]';
  return `[${content.type}]`;
}

/** A compact line diff: the changed middle of old vs new. */
function diffLines(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return [...a.slice(s, a.length - e).map((l) => `-${l}`), ...b.slice(s, b.length - e).map((l) => `+${l}`)];
}

/** Models for this session: what the agent reported, overlaid with agent-models. { id: { label, description } } */
function modelsFor(b) {
  const out = {};
  for (const m of b.agent.models ?? []) out[m.modelId] = { label: m.name, description: m.description };
  for (const [id, info] of Object.entries(getVarOr('agent-models', {}, b))) out[id] = { ...out[id], ...info };
  return out;
}

/** Text columns in the window showing b (100 if it isn't shown or can't be measured). */
function windowColumns(b) {
  const win = windowList().find((w) => w.buffer === b && w.bodyEl?.clientWidth) ?? windowList().find((w) => w.buffer === b);
  const px = win?.bodyEl?.clientWidth;
  const { cw } = viewMetrics();
  return px && cw ? Math.max(20, Math.floor(px / cw) - 2) : 100;
}

/** Column to hard-wrap agent text at (null if disabled). */
function wrapWidth(b) {
  const setting = getVarOr('agent-wrap-column', 0, b);
  if (setting === 0 || setting === false) return null;
  if (typeof setting === 'number') return setting;
  return windowColumns(b);
}

/** Split text into display segments: [{ text, start, end, indent }] (indent = prefix added to continuations). */
function wrapSegments(text, width) {
  if (!width || text.length <= width) return [{ text, start: 0, end: text.length, indent: 0 }];
  const lead = /^(?:\s*(?:│ )*(?:[-*•◦▪]\s+|\d+[.)]\s+)?(?:[☐☑]\s+)?)/.exec(text)[0];
  const pad = ' '.repeat(Math.min(lead.length, Math.floor(width / 2)));
  const segs = [];
  let pos = 0;
  while (pos < text.length) {
    const first = segs.length === 0;
    const room = width - (first ? 0 : pad.length);
    if (text.length - pos <= room) { segs.push({ text: (first ? '' : pad) + text.slice(pos), start: pos, end: text.length, indent: first ? 0 : pad.length }); break; }
    let cut = text.lastIndexOf(' ', pos + room);
    if (cut <= pos + (first ? lead.length : 0)) cut = pos + room; // no good break: hard cut
    segs.push({ text: (first ? '' : pad) + text.slice(pos, cut), start: pos, end: cut, indent: first ? 0 : pad.length });
    pos = cut;
    while (text[pos] === ' ') pos++;
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Images

/** A blob: URL for an image { mimeType, data (base64) }, made once and kept on the object. */
function imageUrl(im) {
  if (!im.url) {
    const bin = atob(im.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    im.url = URL.createObjectURL(new Blob([bytes], { type: im.mimeType || 'image/png' }));
  }
  return im.url;
}

const fileImages = new Map(); // path -> blob: URL, or null while loading / if it failed

/**
 * What to show for ![alt](src) in the agent's Markdown: data: URLs and local image files
 * (absolute, file://, or relative to the agent's directory). Remote images aren't loaded
 * (the webview's CSP blocks them); null also while a file is still being read.
 */
function markdownImageUrl(b, src) {
  if (/^data:image\//i.test(src)) return src;
  if (/^[a-z][\w+.-]+:/i.test(src) && !/^file:/i.test(src)) return null; // http:, https:, ... (C: has a 1-letter scheme, so it falls through)
  let path = src.replace(/^file:\/\//i, '');
  try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1); // file:///C:/x -> C:/x
  path = expandFileName(path.replace(/\\/g, '/'), asDirectory(b.agent.cwd));
  const type = imageMimeType(path);
  if (!type || !isTauri) return null;
  if (fileImages.has(path)) return fileImages.get(path);
  fileImages.set(path, null);
  invoke('read_binary_file', { path })
    .then((buf) => { fileImages.set(path, URL.createObjectURL(new Blob([buf], { type }))); scheduleRedraw(b); })
    .catch(() => {});
  return null;
}

/** A pasted image: attach it to the next message and mark its place in the input. */
function attachImage(b, image) {
  const a = b.agent;
  if (!a.client?.agentCapabilities?.promptCapabilities?.image) {
    throw userError(a.sessionId ? `${a.label} doesn't accept images` : `${a.label} isn't connected yet`);
  }
  const n = a.nextImage++;
  a.attachments.push({ n, ...image });
  if (b.point.pos < b.readOnlyBefore.pos) b.point.set(b.length);
  b.insert(`[image #${n}] `);
  scheduleRedraw(b);
}

/** 12345 -> "12.3k", 1000000 -> "1M". */
function compactNumber(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

/** Header fields (agent-header-fields): name -> (agent, buffer, modelInfo, mode) -> text or null. */
const HEADER_FIELDS = {
  model: (a, b, modelInfo) => `Model: ${modelInfo?.label || a.currentModel || 'unknown'}`,
  effort: (a) => {
    const e = a.effortOption && flatChoices(a.effortOption).find((o) => o.value === a.effortOption.currentValue);
    return e ? `Effort: ${e.name ?? e.value}` : null;
  },
  mode: (a, b, modelInfo, mode) => (mode ? `Mode: ${mode.name}` : null),
  tokens: (a) => `Tokens: ${(a.tokens.input + a.tokens.output).toLocaleString()} (in: ${a.tokens.input.toLocaleString()}, out: ${a.tokens.output.toLocaleString()})`,
  // Tokens in the context window / its size, as the agent reports them (usage_update).
  context: (a) => {
    const c = a.context;
    if (!c?.size) return 'Context: –';
    return `Context: ${compactNumber(c.used ?? 0)} / ${compactNumber(c.size)} (${Math.round(((c.used ?? 0) / c.size) * 100)}%)`;
  },
  // The session's total cost as the agent reports it; otherwise estimated from agent-token-costs.
  cost: (a, b) => {
    if (a.cost?.amount !== undefined) {
      return a.cost.currency && a.cost.currency !== 'USD' ? `Cost: ${a.cost.amount.toFixed(4)} ${a.cost.currency}` : `Cost: $${a.cost.amount.toFixed(4)}`;
    }
    const costs = a.currentModel && getVarOr('agent-token-costs', {}, b)[a.currentModel];
    if (!costs) return 'Cost: –';
    return `Cost: ~$${((a.tokens.input / 1e6) * costs.input + (a.tokens.output / 1e6) * costs.output).toFixed(4)}`;
  },
};

function render(b) {
  const a = b.agent;
  const wrapAt = wrapWidth(b);
  const lines = [];
  const meta = []; // per line: { decos, lineFace, item, images }
  const push = (text, { images, ...extra } = {}) => {
    const segs = wrapSegments(text, wrapAt);
    segs.forEach((seg, k) => {
      const decos = extra.decos?.flatMap((d) => {
        const from = Math.max(d.from, seg.start), to = Math.min(d.to, seg.end);
        return to > from || (d.from === d.to && d.from >= seg.start && d.from <= seg.end)
          ? [{ ...d, from: from - seg.start + seg.indent, to: to - seg.start + seg.indent }] : [];
      });
      lines.push(seg.text);
      const m = decos ? { ...extra, decos } : { ...extra };
      if (images?.length && k === segs.length - 1) m.images = images; // pictures go under the last row
      meta.push(m);
    });
  };
  const maxOut = getVarOr('agent-tool-output-lines', 12, b);
  const indentAll = (text, prefix, face, item) => {
    for (const l of tidyLines(text)) push(l ? `${prefix}${l}` : prefix.trimEnd(), { lineFace: face, item });
  };
  
  const title = `${a.label}  ·  ${abbreviateFileName(a.cwd)}`;
  push(title, { decos: [{ from: 0, to: a.label.length, face: 'agent-title' }, { from: a.label.length, to: title.length, face: 'agent-dim' }] });
  const mode = a.modes?.availableModes?.find((m) => m.id === a.currentMode);
  const models = modelsFor(b);
  const modelInfo = a.currentModel && models[a.currentModel];
  const sub = [
    mode && `mode: ${mode.name}`,
    modelInfo && `model: ${modelInfo.label || a.currentModel}`,
    a.steerPrompts.length > 0 && `steer: ${a.steerPrompts.map(s => s.label).join(', ')}`,
    a.status,
  ].filter(Boolean).join('  ·  ');
  push(sub, { decos: [{ from: 0, to: sub.length, face: 'agent-dim' }] });
  
  // Build header line content (shown at top of window, not in buffer)
  let headerLine = null;
  if (getVarOr('agent-show-banner', true, b) && a.sessionId) {
    const fields = getVarOr('agent-header-fields', ['model', 'effort', 'tokens', 'cost'], b);
    const bannerParts = fields.map((f) => HEADER_FIELDS[f]?.(a, b, modelInfo, mode)).filter(Boolean);
    headerLine = `Session  │  ${bannerParts.join('  │  ')}`;
  }

  let prevType = null;
  for (const item of a.items) {
    // Items that render nothing must not leave a blank line behind.
    if ((item.type === 'thought' && (getVarOr('agent-thought-level', 'full', b) === 'none' || !item.text.trim()))
      || (item.type === 'assistant' && !item.text.trim())) continue;
    const grouped = (item.type === 'assistant' || item.type === 'thought') && prevType === 'tool';
    if (!(item.type === 'tool' && prevType === 'tool') || grouped) push('');
    if (item.type === 'user' && prevType) push(''); // a wider gap where each new turn starts
    prevType = item.type;
    if (item.type === 'user') {
      const shown = item.text.split('\n').map((l, k) => (k ? `  ${l}` : `${PROMPT}${l}`));
      const images = (item.images ?? []).map((im) => ({ src: imageUrl(im), alt: 'image' }));
      shown.forEach((l, k) => push(l, { decos: [{ from: 0, to: l.length, face: 'agent-user' }], item, ...(k === shown.length - 1 ? { images } : {}) }));
    } else if (item.type === 'assistant') {
      const md = renderMarkdown(item.text, {
        raw: !getVarOr('agent-render-markdown', true, b),
        columns: wrapAt ?? windowColumns(b),
        highlight: (lang, code) => highlightSnippet(lang, code, () => scheduleRedraw(b)),
      });
      for (const l of md) {
        const images = l.decos.filter((d) => d.picture).map((d) => ({ src: markdownImageUrl(b, d.url), alt: d.alt })).filter((im) => im.src);
        push(l.text, { decos: l.decos, item, images, ...(l.lineFace ? { lineFace: l.lineFace } : {}) });
      }
    } else if (item.type === 'image') {
      const src = item.data ? imageUrl(item) : null;
      const label = src ? '[image]' : `[image: ${item.uri ?? item.mimeType}]`;
      push(label, { decos: [{ from: 0, to: label.length, face: 'agent-dim' }], item, images: src ? [{ src, alt: 'image' }] : [] });
    } else if (item.type === 'thought') {
      const thoughtLevel = getVarOr('agent-thought-level', 'full', b);
      if (thoughtLevel !== 'none') {
        const all = tidyLines(item.text);
        const collapsed = item.collapsed ?? getVarOr('agent-thoughts-collapsed', false, b);
        const count = all.length === 1 ? '' : ` (${all.length} lines)`;
        const preview = collapsed ? `  ${all.find((l) => l)?.slice(0, 70) ?? ''}${all[0].length > 70 ? '…' : ''}` : '';
        const head = `${collapsed ? '▸' : '▾'} Thinking${count}`;
        push(`${head}${preview}`, { lineFace: 'agent-thought', item, decos: [{ from: 0, to: 1, face: 'agent-fold' }, { from: head.length, to: head.length + preview.length, face: 'agent-dim' }] });
        if (!collapsed) {
          let text = all.join('\n');
          if (thoughtLevel === 'summary') {
            // For summary mode, show only first 2 lines or first 100 chars
            if (all.length > 2 || text.length > 100) {
              text = all.slice(0, 2).join('\n').slice(0, 100);
              if (item.text.length > text.length) text += '…';
            }
          }
          indentAll(text, '│ ', 'agent-thought', item);
        }
      }
    } else if (item.type === 'tool') {
      const icon = STATUS_ICON[item.status] ?? '•';
      const where = item.locations?.[0]?.path ? `  ${abbreviateFileName(item.locations[0].path)}${item.locations[0].line ? `:${item.locations[0].line}` : ''}` : '';
      const text = `  ${icon} ${item.title ?? item.kind ?? 'tool'}`;
      push(`${text}${where}`, { decos: [{ from: 2, to: 3, face: `agent-status-${item.status}` }, { from: 4, to: text.length, face: 'agent-tool' }, { from: text.length, to: text.length + where.length, face: 'agent-dim' }], item });
      for (const c of item.content ?? []) {
        if (c.type === 'content' && c.content?.type === 'image' && c.content.data) {
          push('    [image]', { lineFace: 'agent-output', item, images: [{ src: imageUrl(c.content), alt: 'image' }] });
          continue;
        }
        let out = [];
        if (c.type === 'diff') out = diffLines(c.oldText, c.newText);
        else if (c.type === 'content') out = blockText(c.content).split('\n');
        else if (c.type === 'terminal') {
          const t = a.client?.terminals.get(c.terminalId);
          out = t ? [`$ ${t.command}`, ...t.output.replace(/\n+$/, '').split('\n')] : [];
          if (t?.exit) out.push(`[exit ${t.exit.exitCode ?? t.exit.signal}]`);
        }
        if (!out.length || (out.length === 1 && !out[0])) continue;
        const shown = out.length > maxOut ? [...out.slice(0, maxOut), `… ${out.length - maxOut} more lines`] : out;
        for (const l of shown) {
          const face = c.type === 'diff' ? (l[0] === '+' ? 'git-diff-add' : l[0] === '-' ? 'git-diff-del' : 'agent-dim') : 'agent-output';
          push(`    ${l}`, { lineFace: face, item });
        }
      }
    } else if (item.type === 'plan') {
      push('  ☰ Plan', { decos: [{ from: 2, to: 8, face: 'agent-tool' }], item });
      for (const e of item.entries) {
        const icon = PLAN_ICON[e.status] ?? '○';
        push(`    ${icon} ${e.content}`, { decos: [{ from: 4, to: 5, face: `agent-status-${e.status}` }, ...(e.status === 'completed' ? [{ from: 6, to: 6 + e.content.length, face: 'agent-done' }] : [])], item });
      }
    } else if (item.type === 'command-output') {
      indentAll(item.text, '', 'agent-output', item);
    } else if (item.type === 'info' || item.type === 'error') {
      indentAll(item.text, '', item.type === 'error' ? 'agent-error' : 'agent-info', item);
    }
  }
  push('');
  const status = a.busy || a.promptQueue.length > 0;
  if (a.busy) push(`· ${a.label} is working…  (C-c C-k to cancel)`, { lineFace: 'agent-info' });
  if (a.promptQueue.length > 0) {
    push(`· Queue: ${a.promptQueue.length} prompt${a.promptQueue.length === 1 ? '' : 's'} waiting  (C-c q to view/clear)`, { lineFace: 'agent-info' });
  }
  if (a.attachments.length) {
    if (!status) push('');
    for (const att of a.attachments) {
      const label = `📎 [image #${att.n}]`;
      const hint = '  goes with your next message (delete its [image #n] text to drop it)';
      push(label + hint, {
        decos: [{ from: 0, to: label.length, face: 'agent-tool' }, { from: label.length, to: label.length + hint.length, face: 'agent-dim' }],
        images: [{ src: imageUrl(att), alt: `image #${att.n}` }],
      });
    }
    if (!status) push('');
  }
  // A rule (with padding) between the conversation and the input area.
  if (status) push('');
  push('─'.repeat(Math.max(10, Math.min(wrapAt ?? 80, 200))), { lineFace: 'agent-separator' });
  push('');
  // The input starts on a line of its own, so vim line commands (dd, yy, o, O, cc, 0, ...)
  // work on it as in any buffer. Its "❯ " is display-only (see the decorator in openAgent).
  const transcript = `${lines.join('\n')}\n`;
  return { transcript, meta, headerLine };
}

/**
 * The transcript above the input grew or shrank by `delta`: move the input's undo records
 * with it. (Undo works on absolute offsets and ignores read-only, so stale records would
 * edit the transcript.)
 */
function shiftUndo(b, from, delta) {
  const move = (g) => {
    for (const c of g.changes) if (c.from >= from) c.from += delta;
    if (g.pointBefore >= from) g.pointBefore += delta;
    if (g.pointAfter >= from) g.pointAfter += delta;
  };
  for (const g of b.undoList ?? []) move(g);
  for (const g of b.redoList ?? []) move(g);
  if (b.undoGroup) move(b.undoGroup);
}

/** Redraw the read-only part, leaving the input alone. Only the changed tail is replaced. */
function redraw(b) {
  const a = b.agent;
  if (!a || !b.live) return;
  const { transcript, meta, headerLine } = render(b);
  document.documentElement.style.setProperty('--agent-gap', String(getVarOr('agent-blank-line-height', 0.6, b)));
  const inputStart = b.readOnlyBefore.pos;
  const old = b.getText(0, inputStart);
  let i = 0;
  const n = Math.min(old.length, transcript.length);
  while (i < n && old.charCodeAt(i) === transcript.charCodeAt(i)) i++;
  // Keep point where the user had it.
  const pt = b.point.pos;
  const inInput = pt >= inputStart;
  const fromEnd = b.length - pt;
  const before = pt < i ? null : b.posAt(pt);
  if (i < old.length || i < transcript.length) {
    b.replaceText(i, inputStart, transcript.slice(i), { inhibitReadOnly: true, undo: false });
  }
  b.readOnlyBefore.set(transcript.length);
  if (transcript.length !== inputStart) shiftUndo(b, inputStart, transcript.length - inputStart);
  a.meta = meta;
  if (inInput) b.point.set(b.length - fromEnd);
  else if (before) b.point.set(b.offsetAt(before.line, before.col));
  
  // Update header line in all windows showing this buffer
  for (const win of windowList()) {
    if (win.buffer === b && win.headerLineEl) {
      if (headerLine) {
        win.headerLineEl.textContent = headerLine;
        win.headerLineEl.style.display = '';
      } else {
        win.headerLineEl.style.display = 'none';
      }
    }
  }
  
  b.touch();
}

// Re-wrap when the window changes size.
const redrawAllAgents = () => { for (const x of bufferList({ all: true })) if (x.agent && !x.agent.dead) scheduleRedraw(x); };
addHook('window-configuration-change-hook', redrawAllAgents);
if (typeof window !== 'undefined') window.addEventListener('resize', redrawAllAgents);

function scheduleRedraw(b) {
  if (b.agent.redrawPending) return;
  b.agent.redrawPending = true;
  requestAnimationFrame(() => {
    if (!b.agent) return;
    b.agent.redrawPending = false;
    redraw(b);
  });
}

// ---------------------------------------------------------------------------
// Protocol events

function lastItem(a, type) {
  const last = a.items.at(-1);
  return last?.type === type ? last : null;
}

function onUpdate(b, { update }) {
  const a = b.agent;
  if (!update) return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content?.type === 'image') {
        a.items.push({ type: 'image', mimeType: update.content.mimeType, data: update.content.data, uri: update.content.uri });
        break;
      }
      const item = lastItem(a, 'assistant') ?? (a.items.push({ type: 'assistant', text: '' }), a.items.at(-1));
      item.text += blockText(update.content);
      break;
    }
    case 'agent_thought_chunk': {
      const item = lastItem(a, 'thought') ?? (a.items.push({ type: 'thought', text: '' }), a.items.at(-1));
      item.text += blockText(update.content);
      break;
    }
    case 'user_message_chunk': {
      const item = lastItem(a, 'user') ?? (a.items.push({ type: 'user', text: '' }), a.items.at(-1));
      item.text += blockText(update.content);
      break;
    }
    case 'tool_call':
    case 'tool_call_update': {
      let item = a.items.find((x) => x.type === 'tool' && x.id === update.toolCallId);
      if (!item) {
        item = { type: 'tool', id: update.toolCallId, status: 'pending', content: [] };
        a.items.push(item);
      }
      for (const k of ['title', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput']) {
        if (update[k] !== undefined && update[k] !== null) item[k] = update[k];
      }
      break;
    }
    case 'plan': {
      let item = a.items.find((x) => x.type === 'plan');
      if (!item) { item = { type: 'plan', entries: [] }; a.items.push(item); }
      item.entries = update.entries ?? [];
      break;
    }
    case 'available_commands_update':
      a.commands = update.availableCommands ?? [];
      break;
    case 'current_mode_update':
      a.currentMode = update.currentModeId;
      break;
    case 'usage_update':
      // Context window use, and (at the end of a turn) the session's total cost.
      a.context = { used: update.used, size: update.size };
      if (update.cost) a.cost = update.cost;
      break;
    default:
      return;
  }
  runHooks('agent-update-hook', b, update);
  scheduleRedraw(b);
  scheduleTranscriptSave(b);
}

async function requestPermission(b, params) {
  const { toolCall, options } = params;
  const title = toolCall?.title ?? 'the tool call';
  const tool = b.agent.items.find((x) => x.type === 'tool' && x.id === toolCall?.toolCallId);
  if (tool && toolCall) Object.assign(tool, Object.fromEntries(Object.entries(toolCall).filter(([, v]) => v !== undefined && v !== null)));
  scheduleRedraw(b);
  const label = { allow_once: 'Allow', allow_always: 'Always allow', reject_once: 'Reject', reject_always: 'Always reject' };
  try {
    const optionId = await completingRead(`${b.agent.label} wants to: ${title} — `, options.map((o) => ({
      label: o.name ?? label[o.kind] ?? o.optionId,
      value: o.optionId,
      annotation: label[o.kind] ?? o.kind,
    })), { sourceName: 'Permission' });
    return { outcome: { outcome: 'selected', optionId } };
  } catch (e) {
    if (e instanceof Quit) return { outcome: { outcome: 'cancelled' } };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Sessions

/** Find (or start) the agent buffer for an agent and directory. */
export async function openAgent({ name = getVarOr('agent-default', 'claude-code'), cwd, display = true } = {}) {
  if (!isTauri) throw userError('Agents need the app (not a plain browser)');
  const def = getVarOr('agent-definitions', {}, null)[name];
  if (!def) throw userError(`Unknown agent: ${name} (see agent-definitions)`);
  cwd = cwd ?? await projectRoot();
  const existing = bufferList({ all: true }).find((x) => x.agent?.name === name && x.agent.cwd === cwd && !x.agent.dead);
  if (existing) {
    if (display) setWindowBuffer(selectedWindow(), existing);
    return existing;
  }
  const label = def.label ?? name;
  const b = getBufferCreate(generateNewBufferName(`*${label}: ${basename(cwd)}*`));
  setMajorMode(b, 'agent-mode');
  b.undoEnabled = true;
  b.locals.set('default-directory', cwd);
  b.locals.set('display-line-numbers', false);
  b.locals.set('truncate-lines', false); // soft-wrap; reflows automatically on resize
  b.readOnlyBefore = new Marker(b, 0);
  b.agent = { 
    name, label, cwd, def, items: [], meta: [], busy: false, status: 'starting…', 
    modes: null, currentMode: null, currentModel: null, models: null, 
    commands: [], client: null, sessionId: null, promptQueue: [], processingQueue: false,
    steerPrompts: [], // Active steering prompts
    tokens: { input: 0, output: 0 }, // Token usage tracking
    attachments: [], nextImage: 1, // pasted images waiting to be sent: [{ n, mimeType, data }]
  };
  b.onPasteImage = (image) => attachImage(b, image);
  b.decorators.push((buf, line) => {
    // Input lines: the prompt (and an indent on continuation lines) is display-only text.
    const inputLine = buf.lineAt(buf.readOnlyBefore.pos);
    if (line >= inputLine) return [line === inputLine ? { before: PROMPT, face: 'agent-prompt' } : { before: ' '.repeat(PROMPT.length) }];
    const m = buf.agent?.meta?.[line];
    if (!m) return [];
    if (!m.lineFace && !m.images && buf.lineText(line) === '') return [{ lineFace: 'agent-gap' }]; // a shorter blank line
    return [...(m.decos ?? []), ...(m.lineFace ? [{ lineFace: m.lineFace }] : []), ...(m.images ?? []).map((image) => ({ image }))];
  });
  redraw(b);
  if (display) setWindowBuffer(selectedWindow(), b);
  b.state = 'insert';
  b.point.set(b.length);
  startSession(b).catch((e) => {
    b.agent.status = 'not connected';
    b.agent.items.push({ type: 'error', text: `Could not start ${label}: ${e.message ?? e}` });
    const why = stderrTail(b);
    if (why) b.agent.items.push({ type: 'info', text: `The agent said:\n${why}` });
    if (/ENOENT|not found|No such file/i.test(String(e.message ?? e))) {
      b.agent.items.push({ type: 'info', text: `Is "${def.command}" installed and on your PATH? (Claude Code needs Node.js for npx.)` });
    }
    scheduleRedraw(b);
  });
  return b;
}

async function projectRoot() {
  const dir = getVarOr('default-directory', '/');
  try {
    const { repoRoot } = await import('../git/git.js');
    return (await repoRoot(dir)) ?? dir;
  } catch {
    return dir;
  }
}

/** The last few lines the agent wrote to stderr (where its real error messages go). */
function stderrTail(b, lines = 6) {
  const log = getBuffer(`*${b.agent.label} log*`);
  if (!log) return '';
  // Only what this start attempt wrote.
  const text = log.getText(b.agent.logFrom ?? 0, log.length).replace(/\x1b\[[0-9;]*m/g, '');
  return text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-lines).join('\n');
}

async function startSession(b) {
  const a = b.agent;
  const stderr = getBufferCreate(`*${a.label} log*`);
  a.logFrom = stderr.length;
  const client = new AcpClient({ ...a.def, cwd: a.cwd, envRemove: [...getVarOr('agent-env-remove', [], null), ...(a.def.envRemove ?? [])] }, {
    onUpdate: (p) => onUpdate(b, p),
    requestPermission: (p) => requestPermission(b, p),
    onStderr: (text) => {
      stderr.undoEnabled = false;
      stderr.append(text);
      if (a.turn) a.turn.stderr += text; // local command output arrives here (see finishTurn)
    },
    onExit: (code) => {
      a.dead = true;
      a.busy = false;
      a.status = 'disconnected';
      a.items.push({ type: 'info', text: `[${a.label} exited${code !== null && code !== undefined ? ` with code ${code}` : ''}; M-x agent-restart to start again]` });
      scheduleRedraw(b);
      saveTranscript(b).catch(() => {});
    },
    onTerminalOutput: () => scheduleRedraw(b),
  });
  a.client = client;
  a.status = 'connecting…';
  scheduleRedraw(b);
  await client.start();
  await newSession(b);
}

async function newSession(b) {
  const a = b.agent;
  try {
    const res = await a.client.newSession(a.cwd.replace(/\/$/, '') || '/', await mcpServersFor(b));
    a.sessionId = res.sessionId;
    a.context = null; // filled in by the agent's usage updates
    a.cost = null;
    a.modes = res.modes ?? null;
    a.currentMode = res.modes?.currentModeId ?? null;
    // Newer agents report models as a "model" config option; older ones as `models`.
    if (findOption(res.configOptions, 'model', 'model')) {
      applyConfigOptions(a, res.configOptions);
    } else {
      a.models = res.models?.availableModels ?? null;
      a.currentModel = res.models?.currentModelId ?? null;
      a.modelConfigId = null;
    }
    const want = getVarOr('agent-default-model', null, b);
    if (want && want !== a.currentModel && a.models?.some((m) => m.modelId === want)) {
      await setAgentModel(a, want).then(() => { a.currentModel = want; }).catch(() => {});
    }
    a.status = null;
    runHooks('agent-session-started-hook', b);
  } catch (e) {
    if (e.code === -32000 || /auth/i.test(e.message)) {
      a.status = 'needs login';
      const methods = a.client.authMethods.map((m) => `${m.name ?? m.id}${m.description ? ` (${m.description})` : ''}`).join('; ');
      a.items.push({ type: 'error', text: `Authentication required. ${methods ? `Methods: ${methods}. ` : ''}Run M-x agent-authenticate, or log in from a terminal (for Claude Code: run "claude" and use /login), then M-x agent-restart.` });
    } else {
      throw e;
    }
  }
  scheduleRedraw(b);
}

const flatChoices = (opt) => (opt?.options ?? []).flatMap((o) => o.options ?? [o]);
const findOption = (opts, id, category) => opts?.find((o) => o.id === id || (category && o.category === category));

/** Take the agent's current configOptions (model, effort, ...) as the truth. */
function applyConfigOptions(a, opts) {
  if (!opts) return;
  a.configOptions = opts;
  const model = findOption(opts, 'model', 'model');
  if (model) {
    a.models = flatChoices(model).map((o) => ({ modelId: o.value, name: o.name, description: o.description }));
    a.currentModel = model.currentValue ?? null;
    a.modelConfigId = model.id;
  }
  const effort = findOption(opts, 'effort', 'thought_level');
  a.effortOption = effort ?? null;
}

async function setAgentModel(a, modelId) {
  if (!a.modelConfigId) return a.client.setModel(a.sessionId, modelId);
  const res = await a.client.setConfigOption(a.sessionId, a.modelConfigId, modelId);
  applyConfigOptions(a, res?.configOptions); // a model switch can change the effort choices
}

function requireAgent() {
  const b = currentBuffer();
  if (!b.agent) throw userError('Not an agent buffer');
  return b;
}

/** Turn "@path" mentions into resource links the agent can read. */
async function promptBlocks(text, cwd, steerPrompts = [], images = []) {
  const blocks = [];
  
  // Add steering prompts first (as system-level guidance)
  if (steerPrompts.length > 0) {
    const steerText = steerPrompts.map(s => s.prompt).join('\n\n');
    blocks.push({ type: 'text', text: `[Steering guidance: ${steerText}]\n\n` });
  }
  
  blocks.push({ type: 'text', text });
  for (const im of images) blocks.push({ type: 'image', mimeType: im.mimeType, data: im.data });
  
  const seen = new Set();
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const path = expandFileName(m[1], cwd);
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      if ((await pathInfo(path)).isFile) blocks.push({ type: 'resource_link', uri: `file://${path}`, name: m[1] });
    } catch { /* not a file */ }
  }
  return blocks;
}

/** Output blocks of locally run commands found in agent stderr: [{ stream, text }]. */
const localOutputs = (s) => [...s.matchAll(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g)]
  .map((m) => ({ stream: m[1], text: m[2].replace(/\x1b\[[0-9;]*m/g, '').trim() }))
  .filter((o) => o.text);

/**
 * End of a turn. Claude Code runs some slash commands (/usage, /cost, /status, ...)
 * locally, and its ACP adapter only logs their output to stderr; show it here. A turn
 * that produced nothing at all says so instead of ending silently.
 */
async function finishTurn(b) {
  const a = b.agent;
  const t = a.turn;
  if (!t) return;
  const produced = () => a.items.slice(t.start).some((i) => i.type !== 'info');
  // stderr and the turn's reply travel on different pipes; give stderr a moment.
  if (!produced() && !localOutputs(t.stderr).length) await new Promise((r) => setTimeout(r, 150));
  if (!produced()) {
    for (const o of localOutputs(t.stderr)) a.items.push({ type: o.stream === 'stderr' ? 'error' : 'command-output', text: o.text });
  }
  if (!produced()) {
    const cmd = /^\/(\S+)/.exec(t.text)?.[1];
    const known = (a.commands ?? []).some((c) => c.name === cmd);
    a.items.push({
      type: 'info',
      text: cmd && !known && a.commands?.length
        ? `[no response: /${cmd} isn't one of ${a.label}'s available commands here; C-c / lists them]`
        : '[no response]',
    });
  }
}

/** Process the prompt queue if not already processing. */
async function processQueue(b) {
  const a = b.agent;
  if (a.processingQueue || a.busy || a.promptQueue.length === 0) return;
  
  a.processingQueue = true;
  while (a.promptQueue.length > 0 && !a.dead) {
    const nextPrompt = a.promptQueue.shift();
    scheduleRedraw(b);
    try {
      await agentSend(b, nextPrompt);
    } catch (e) {
      a.items.push({ type: 'error', text: `Queue error: ${e.message ?? e}` });
      scheduleRedraw(b);
      break; // Stop processing queue on error
    }
  }
  a.processingQueue = false;
  scheduleRedraw(b);
}

/** Send a message (default: the input after the prompt). */
export async function agentSend(b, text, options = {}) {
  const a = b.agent;
  const { skipQueue = false } = options;
  const inputStart = b.readOnlyBefore.pos;
  const fromInput = text === undefined; // else (the queue) the input holds a draft that stays
  if (fromInput) {
    text = b.getText(inputStart, b.length).trim();
    if (!text) return;
  }
  if (a.dead || !a.sessionId) throw userError(`${a.label} isn't connected (M-x agent-restart)`);
  if (a.busy && !skipQueue) throw userError(`${a.label} is still working (C-c C-k to cancel)`);
  if (fromInput) {
    b.deleteText(inputStart, b.length, { undo: false });
    // Undo history belongs to the message just sent; it would reinsert stale text.
    b.undoList = []; b.redoList = []; b.undoGroup = null;
  }
  const images = a.attachments.filter((x) => text.includes(`[image #${x.n}]`));
  a.attachments = a.attachments.filter((x) => !images.includes(x));
  a.items.push({ type: 'user', text, ...(images.length ? { images } : {}) });
  a.busy = true;
  a.turn = { text, stderr: '', start: a.items.length };
  redraw(b);
  scheduleTranscriptSave(b);
  b.point.set(b.length);
  try {
    const res = await a.client.prompt(a.sessionId, await promptBlocks(text, a.cwd, a.steerPrompts, images));
    await finishTurn(b);
    
    // Update token usage if provided
    if (res?.usage) {
      a.tokens.input += res.usage.inputTokens || 0;
      a.tokens.output += res.usage.outputTokens || 0;
    }
    
    if (res?.stopReason && res.stopReason !== 'end_turn') a.items.push({ type: 'info', text: `[stopped: ${res.stopReason.replace(/_/g, ' ')}]` });
  } catch (e) {
    a.items.push({ type: 'error', text: `Error: ${e.message ?? e}` });
  } finally {
    a.turn = null;
    a.busy = false;
    scheduleRedraw(b);
    saveTranscript(b).catch((e) => message('Could not save transcript: %s', e.message ?? e));
    runHooks('agent-turn-finished-hook', b);
    // Process next item in queue if any
    if (!skipQueue) processQueue(b);
  }
}

// ---------------------------------------------------------------------------
// Commands

defcommand('agent', { doc: 'Open the default agent (Claude Code) for this project (SPC a a).' }, () => openAgent());

defcommand('agent-select', { doc: 'Start a chosen agent for this project (SPC a A).' }, async () => {
  const defs = getVarOr('agent-definitions', {}, null);
  const name = await completingRead('Agent: ', Object.entries(defs).map(([k, d]) => ({ label: d.label ?? k, value: k, annotation: [d.command, ...(d.args ?? [])].join(' ') })));
  return openAgent({ name });
});

defcommand('select-agent', { doc: 'Switch to an active agent buffer or start a new one.' }, async () => {
  const agents = bufferList({ all: true }).filter((b) => b.agent && !b.agent.dead);
  const defs = getVarOr('agent-definitions', {}, null);
  
  if (agents.length === 0) {
    // No active agents, start a new one
    const name = await completingRead('Start agent: ', Object.entries(defs).map(([k, d]) => ({ label: d.label ?? k, value: k, annotation: [d.command, ...(d.args ?? [])].join(' ') })));
    return openAgent({ name });
  }
  
  // Build list of active agents + option to start new
  const choices = [
    ...agents.map((b) => ({
      label: `${b.agent.label} (${abbreviateFileName(b.agent.cwd)})`,
      value: { type: 'buffer', buffer: b },
      annotation: b.agent.status || (b.agent.busy ? 'working…' : 'ready'),
    })),
    { label: '── Start new agent ──', value: { type: 'new' }, annotation: '' },
  ];
  
  const choice = await completingRead('Agent: ', choices);
  
  if (choice.type === 'buffer') {
    setWindowBuffer(selectedWindow(), choice.buffer);
    return choice.buffer;
  } else {
    // Start a new agent
    const name = await completingRead('Start agent: ', Object.entries(defs).map(([k, d]) => ({ label: d.label ?? k, value: k, annotation: [d.command, ...(d.args ?? [])].join(' ') })));
    return openAgent({ name });
  }
});

defcommand('agent-send', { doc: 'Send the input to the agent (RET in normal state, C-c C-c).' }, () => agentSend(requireAgent()));

defcommand('agent-queue-prompt', { doc: 'Add the current input to the prompt queue for sequential execution.' }, () => {
  const b = requireAgent();
  const a = b.agent;
  const inputStart = b.readOnlyBefore.pos;
  const text = b.getText(inputStart, b.length).trim();
  if (!text) throw userError('No prompt to queue');
  
  a.promptQueue.push(text);
  b.deleteText(inputStart, b.length, { undo: false });
  b.undoList = []; b.redoList = []; b.undoGroup = null;
  message('Prompt queued (%d in queue)', a.promptQueue.length);
  scheduleRedraw(b);
  
  // Start processing if not busy
  if (!a.busy) processQueue(b);
});

defcommand('agent-view-queue', { doc: 'View and manage the prompt queue.' }, async () => {
  const b = requireAgent();
  const a = b.agent;
  
  if (a.promptQueue.length === 0) {
    message('Queue is empty');
    return;
  }
  
  const choices = [
    ...a.promptQueue.map((p, i) => ({
      label: `${i + 1}. ${p.slice(0, 60)}${p.length > 60 ? '…' : ''}`,
      value: { action: 'remove', index: i },
      annotation: `${p.length} chars`,
    })),
    { label: '── Clear all ──', value: { action: 'clear' }, annotation: '' },
  ];
  
  try {
    const choice = await completingRead('Queue: ', choices);
    if (choice.action === 'clear') {
      a.promptQueue = [];
      message('Queue cleared');
    } else if (choice.action === 'remove') {
      const removed = a.promptQueue.splice(choice.index, 1)[0];
      message('Removed from queue: %s', removed.slice(0, 40));
    }
    scheduleRedraw(b);
  } catch (e) {
    // User cancelled
  }
});

defcommand('agent-add-steer', { doc: 'Add a steering prompt to guide agent behavior.' }, async () => {
  const b = requireAgent();
  const a = b.agent;
  const presets = getVarOr('agent-steer-presets', {}, b);
  
  const choices = [
    ...Object.entries(presets).map(([id, info]) => ({
      label: info.label || id,
      value: { type: 'preset', id, ...info },
      annotation: info.prompt?.slice(0, 80),
    })),
    { label: '── Custom steering prompt ──', value: { type: 'custom' }, annotation: '' },
  ];
  
  const choice = await completingRead('Add steering: ', choices);
  
  if (choice.type === 'custom') {
    const { readFromMinibuffer } = await import('../core/helm/helm.js');
    const customPrompt = await readFromMinibuffer('Custom steering prompt: ');
    if (!customPrompt.trim()) return;
    a.steerPrompts.push({ label: 'Custom', prompt: customPrompt });
    message('Added custom steering prompt');
  } else {
    // Check if already active
    if (a.steerPrompts.some(s => s.label === choice.label)) {
      message('Steering "%s" already active', choice.label);
      return;
    }
    a.steerPrompts.push({ label: choice.label, prompt: choice.prompt });
    message('Added steering: %s', choice.label);
  }
  scheduleRedraw(b);
});

defcommand('agent-remove-steer', { doc: 'Remove an active steering prompt.' }, async () => {
  const b = requireAgent();
  const a = b.agent;
  
  if (a.steerPrompts.length === 0) {
    message('No active steering prompts');
    return;
  }
  
  const choices = [
    ...a.steerPrompts.map((s, i) => ({
      label: s.label,
      value: { action: 'remove', index: i },
      annotation: s.prompt?.slice(0, 60),
    })),
    { label: '── Clear all ──', value: { action: 'clear' }, annotation: '' },
  ];
  
  try {
    const choice = await completingRead('Remove steering: ', choices);
    if (choice.action === 'clear') {
      a.steerPrompts = [];
      message('All steering cleared');
    } else if (choice.action === 'remove') {
      const removed = a.steerPrompts.splice(choice.index, 1)[0];
      message('Removed steering: %s', removed.label);
    }
    scheduleRedraw(b);
  } catch (e) {
    // User cancelled
  }
});

defcommand('agent-return', { doc: 'RET: send when in the input; on a tool line, open its file.' }, async () => {
  const b = requireAgent();
  if (b.point.pos >= b.readOnlyBefore.pos) return agentSend(b);
  const m = b.agent.meta[b.lineAt()];
  const item = m?.item;
  if (item?.type === 'thought') return call('agent-toggle-thought');
  const col = b.posAt(b.point.pos).col;
  const link = m?.decos?.find((d) => d.url && d.from <= col && col < d.to);
  if (link) return message('%s', link.url);
  const loc = item?.locations?.[0];
  if (loc?.path) {
    const { openFile } = await import('../commands/files.js');
    const fb = await openFile(loc.path, { otherWindow: true });
    if (loc.line) fb.point.set(fb.offsetAt(loc.line - 1, 0));
    return;
  }
  b.point.set(b.length);
});

function thoughtAtPoint(b) {
  const item = b.agent.meta[b.lineAt()]?.item;
  return item?.type === 'thought' ? item : null;
}

/** Redraw and put point on the item's first line (its body may have just disappeared). */
function redrawAt(b, item) {
  redraw(b);
  const line = b.agent.meta.findIndex((m) => m?.item === item);
  if (line >= 0) b.point.set(b.offsetAt(line, 0));
}

defcommand('agent-toggle-thought', { doc: 'Expand or collapse the thinking section at point (TAB).' }, () => {
  const b = requireAgent();
  const item = thoughtAtPoint(b);
  if (!item) { message('No thinking section here (move onto one, or S-TAB for all)'); return; }
  toggleThought(b, item);
});

function toggleThought(b, item) {
  item.collapsed = !(item.collapsed ?? getVarOr('agent-thoughts-collapsed', false, b));
  redrawAt(b, item);
}

defcommand('agent-tab', { doc: 'TAB: toggle the thinking section at point when point is in the transcript; indent in the input.' }, () => {
  const b = requireAgent();
  if (b.point.pos < b.readOnlyBefore.pos) return call('agent-toggle-thought');
  return call('indent-for-tab-command');
});

// Clicking the ▾/▸ marker of a thinking section toggles it.
addHook('mouse-set-point-hook', function agentClickFold(win, off) {
  const b = win.buffer;
  if (!b?.agent || off >= b.readOnlyBefore.pos) return;
  const { line, col } = b.posAt(off);
  const m = b.agent.meta[line];
  if (col > 1 || m?.item?.type !== 'thought' || b.agent.meta.findIndex((x) => x?.item === m.item) !== line) return;
  toggleThought(b, m.item);
});

defcommand('agent-toggle-all-thoughts', { doc: 'Collapse all thinking sections, or expand them all if they are all collapsed (S-TAB).' }, () => {
  const b = requireAgent();
  const thoughts = b.agent.items.filter((i) => i.type === 'thought');
  if (!thoughts.length) return;
  const dflt = getVarOr('agent-thoughts-collapsed', false, b);
  const collapse = thoughts.some((t) => !(t.collapsed ?? dflt));
  for (const t of thoughts) t.collapsed = collapse;
  redrawAt(b, thoughtAtPoint(b) ?? thoughts.at(-1));
  message(collapse ? 'Thinking collapsed' : 'Thinking expanded');
});

defcommand('agent-newline', { doc: 'Insert a newline in the input (S-RET, C-j).' }, () => {
  const b = requireAgent();
  if (b.point.pos < b.readOnlyBefore.pos) b.point.set(b.length);
  b.insert('\n');
});

defcommand('agent-cancel', { doc: 'Cancel the agent\'s current turn (C-c C-k).' }, async () => {
  const b = requireAgent();
  if (!b.agent.busy) return message('Nothing to cancel');
  await b.agent.client.cancel(b.agent.sessionId);
  message('Cancelling…');
});

defcommand('agent-set-mode', { doc: 'Change the session mode, e.g. plan or accept edits (C-c m).' }, async () => {
  const b = requireAgent();
  const modes = b.agent.modes?.availableModes;
  if (!modes?.length) throw userError(`${b.agent.label} has no modes`);
  const id = await completingRead('Mode: ', modes.map((m) => ({ label: m.name, value: m.id, annotation: `${m.id === b.agent.currentMode ? 'current  ' : ''}${m.description ?? ''}` })));
  await b.agent.client.setMode(b.agent.sessionId, id);
  b.agent.currentMode = id;
  scheduleRedraw(b);
});

defcommand('select-effort', { doc: 'Set the agent\'s effort level (how hard it thinks), as Claude Code\'s /model does.' }, async () => {
  const b = requireAgent();
  const a = b.agent;
  if (!a.sessionId) throw userError('No active session');
  const opt = a.effortOption;
  if (!opt) throw userError('This agent/model has no effort setting');
  const choices = flatChoices(opt).map((o) => ({
    label: o.name ?? o.value,
    value: o.value,
    annotation: `${o.value === opt.currentValue ? 'current  ' : ''}${o.description ?? ''}`,
  }));
  const value = await completingRead('Effort: ', choices);
  const res = await a.client.setConfigOption(a.sessionId, opt.id, value);
  if (res?.configOptions) applyConfigOptions(a, res.configOptions);
  else opt.currentValue = value;
  scheduleRedraw(b);
  message('Effort set to: %s', choices.find((c) => c.value === value)?.label ?? value);
});

defcommand('select-model', { doc: 'Change the AI model used by the agent.' }, async () => {
  const b = requireAgent();
  if (!b.agent.sessionId) throw userError('No active session');
  const models = modelsFor(b);
  if (Object.keys(models).length === 0) throw userError('The agent reported no models');
  
  const current = b.agent.currentModel;
  const choices = Object.entries(models).map(([id, info]) => ({
    label: info.label || id,
    value: id,
    annotation: `${id === current ? 'current  ' : ''}${info.description || ''}`,
  }));
  
  const modelId = await completingRead('Model: ', choices);
  
  try {
    await setAgentModel(b.agent, modelId);
    b.agent.currentModel = modelId;
    scheduleRedraw(b);
    message('Model changed to: %s', models[modelId]?.label || modelId);
  } catch (e) {
    // If the protocol doesn't support model switching, just update locally
    if (e.code === -32601) {
      b.agent.currentModel = modelId;
      scheduleRedraw(b);
      message('Model preference set to: %s (may take effect on next session)', models[modelId]?.label || modelId);
    } else {
      throw e;
    }
  }
});

defcommand('agent-new-session', { doc: 'Start a fresh conversation in this buffer.' }, async () => {
  const b = requireAgent();
  if (b.agent.busy) await b.agent.client.cancel(b.agent.sessionId).catch(() => {});
  await saveTranscript(b).catch(() => {});
  b.agent.transcript = null; // the next conversation gets its own file
  b.agent.items = [];
  b.agent.attachments = [];
  b.agent.status = 'new session…';
  redraw(b);
  await newSession(b);
});

defcommand('agent-restart', { doc: 'Restart the agent process and start a new session.' }, async () => {
  const b = requireAgent();
  await b.agent.client?.kill();
  b.agent.dead = false;
  b.agent.busy = false;
  b.agent.items.push({ type: 'info', text: '[restarting…]' });
  await startSession(b).catch((e) => {
    b.agent.items.push({ type: 'error', text: `Could not start: ${e.message ?? e}` });
    const why = stderrTail(b);
    if (why) b.agent.items.push({ type: 'info', text: `The agent said:\n${why}` });
    scheduleRedraw(b);
  });
});

defcommand('agent-authenticate', { doc: 'Choose an authentication method offered by the agent.' }, async () => {
  const b = requireAgent();
  const methods = b.agent.client?.authMethods ?? [];
  if (!methods.length) throw userError('The agent offers no authentication methods');
  const id = await completingRead('Authenticate with: ', methods.map((m) => ({ label: m.name ?? m.id, value: m.id, annotation: m.description ?? '' })));
  await b.agent.client.authenticate(id);
  message('Authenticated; starting a session…');
  await newSession(b);
});

defcommand('agent-slash-command', { doc: 'Insert one of the agent\'s slash commands into the input.' }, async () => {
  const b = requireAgent();
  const cmds = b.agent.commands ?? [];
  if (!cmds.length) throw userError('The agent has not advertised any commands');
  const name = await completingRead('Command: ', cmds.map((c) => ({ label: `/${c.name}`, value: c.name, annotation: c.description ?? '' })));
  b.point.set(b.length);
  b.insert(`/${name} `);
  await call('vim-insert');
});

/** From any buffer: put a reference to the file (and selection) into the agent's input. */
defcommand('agent-add-context', { doc: 'Add the current file (and selected lines) to the agent\'s input as an @mention (SPC a f).' }, async () => {
  const src = currentBuffer();
  if (!src.file) throw userError('Buffer is not visiting a file');
  let range = '';
  if (src.state === 'visual' && src.vim?.visual) {
    const { visualRange, exitVisual } = await import('../vim/core.js');
    const r = visualRange(src);
    exitVisual(src);
    const l1 = src.lineAt(r.from) + 1;
    const l2 = src.lineAt(Math.max(r.from, r.to - 1)) + 1;
    range = l1 === l2 ? ` (line ${l1})` : ` (lines ${l1}-${l2})`;
  }
  const b = await openAgent({ display: false });
  displayBuffer(b, { otherWindow: true });
  const rel = src.file.startsWith(b.agent.cwd) ? src.file.slice(b.agent.cwd.length) : src.file;
  b.point.set(b.length);
  b.insert(`@${rel}${range} `);
  b.state = 'insert';
  b.touch();
});

// i/a/I/A/o/O in the transcript jump to the end of the input (and just insert there);
// in the input they behave as usual.
for (const [key, cmd] of [['i', 'vim-insert'], ['a', 'vim-append'], ['I', 'vim-insert-line'], ['A', 'vim-append-line'], ['o', 'vim-open-below'], ['O', 'vim-open-above']]) {
  defcommand(`agent-${cmd}`, { doc: `${cmd}, jumping to the input first when the cursor is in the transcript.` }, () => {
    const b = requireAgent();
    if (b.point.pos < b.readOnlyBefore.pos) {
      b.point.set(b.length);
      return call('vim-insert');
    }
    return call(cmd);
  });
  defineKey({ keymaps: 'agent-mode-map', states: 'normal' }, { [key]: `agent-${cmd}` });
}

addHook('kill-buffer-hook', function agentStop(b) {
  if (!b.agent) return;
  saveTranscript(b).catch(() => {});
  if (b.agent.client) b.agent.client.kill();
});

// ---------------------------------------------------------------------------
// Transcripts (Markdown in <cwd>/.polymer/agent/)

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const fence = (text, lang = '') => {
  // A fence longer than any backtick run inside the text.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n+$/, '')}\n${f}`;
};

/** The conversation as Markdown. */
export function transcriptMarkdown(b) {
  const a = b.agent;
  const out = [`# ${a.label} — ${abbreviateFileName(a.cwd)}`, ''];
  const started = a.transcript?.startedAt ?? new Date();
  out.push(`Started ${started.toLocaleString()}${a.sessionId ? ` · session \`${a.sessionId}\`` : ''}`, '');
  const STATUS = { pending: '…', in_progress: '⟳', completed: '✓', failed: '✗' };
  for (const item of a.items) {
    if (item.type === 'user') {
      out.push('## You', '', item.text, '');
      if (item.images?.length) out.push(`_[${item.images.length} image${item.images.length === 1 ? '' : 's'} attached]_`, '');
    } else if (item.type === 'image') {
      out.push(`_[image${item.uri ? `: ${item.uri}` : ''}]_`, '');
    } else if (item.type === 'assistant') {
      out.push(`## ${a.label}`, '', item.text.replace(/\n+$/, ''), '');
    } else if (item.type === 'thought') {
      out.push(item.text.replace(/\n+$/, '').split('\n').map((l) => `> _${l || ' '}_`).join('\n'), '');
    } else if (item.type === 'tool') {
      const loc = item.locations?.[0]?.path ? ` — \`${abbreviateFileName(item.locations[0].path)}${item.locations[0].line ? `:${item.locations[0].line}` : ''}\`` : '';
      out.push(`**${STATUS[item.status] ?? '•'} ${item.title ?? item.kind ?? 'tool'}**${loc}`, '');
      for (const c of item.content ?? []) {
        if (c.type === 'diff') {
          out.push(`\`${abbreviateFileName(c.path ?? '')}\``, '', fence(diffLines(c.oldText, c.newText).join('\n'), 'diff'), '');
        } else if (c.type === 'content') {
          const t = blockText(c.content);
          if (t.trim()) out.push(fence(t), '');
        } else if (c.type === 'terminal') {
          const t = a.client?.terminals.get(c.terminalId);
          if (t) {
            const lines = t.output.replace(/\n+$/, '').split('\n');
            const shown = lines.length > 200 ? [...lines.slice(-200)] : lines;
            out.push(fence(`$ ${t.command}\n${shown.join('\n')}${t.exit ? `\n[exit ${t.exit.exitCode ?? t.exit.signal}]` : ''}`, 'console'), '');
          }
        }
      }
    } else if (item.type === 'plan') {
      out.push('### Plan', '', ...item.entries.map((e) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}${e.status === 'in_progress' ? ' _(in progress)_' : ''}`), '');
    } else if (item.type === 'command-output') {
      out.push(fence(item.text), '');
    } else if (item.type === 'info' || item.type === 'error') {
      out.push(`_${item.text}_`, '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

const transcriptDir = (b) => asDirectory(expandFileName(getVarOr('agent-transcript-directory', '.polymer/agent/', b), asDirectory(b.agent.cwd)));

/** Write the transcript now (only once the conversation has a message). Returns the path. */
export async function saveTranscript(b) {
  const a = b.agent;
  if (!a || !getVarOr('agent-save-transcripts', true, b)) return null;
  clearTimeout(a.saveTimer);
  if (!a.items.some((i) => i.type === 'user')) return null;
  if (!a.transcript) {
    const startedAt = new Date();
    a.transcript = { startedAt, path: `${transcriptDir(b)}${stamp(startedAt)}-${a.name}.md` };
  }
  await makeDirectory(transcriptDir(b));
  await writeTextFile(a.transcript.path, transcriptMarkdown(b), false);
  runHooks('agent-transcript-saved-hook', b, a.transcript.path);
  return a.transcript.path;
}

function scheduleTranscriptSave(b) {
  const a = b.agent;
  if (!a || !getVarOr('agent-save-transcripts', true, b)) return;
  clearTimeout(a.saveTimer);
  a.saveTimer = setTimeout(() => saveTranscript(b).catch(() => {}), getVarOr('agent-transcript-save-delay', 2000, b));
}

defcommand('agent-open-transcript', { doc: 'Open this conversation\'s saved transcript (SPC a t).' }, async () => {
  const b = requireAgent();
  const path = await saveTranscript(b);
  if (!path) throw userError('Nothing to save yet');
  const { openFile } = await import('../commands/files.js');
  return openFile(path, { otherWindow: true });
});

defcommand('agent-browse-transcripts', { doc: 'Open a saved transcript from this project (SPC a T).' }, async () => {
  const b = currentBuffer();
  const cwd = b.agent?.cwd ?? await projectRoot();
  const dir = asDirectory(expandFileName(getVarOr('agent-transcript-directory', '.polymer/agent/', b), asDirectory(cwd)));
  let entries = [];
  try { entries = (await listDirectory(dir)).filter((e) => !e.isDir && e.name.endsWith('.md')); } catch { /* none yet */ }
  if (!entries.length) throw userError(`No transcripts in ${abbreviateFileName(dir)}`);
  const names = entries.map((e) => e.name).sort().reverse(); // newest first
  const name = await completingRead('Transcript: ', names);
  const { openFile } = await import('../commands/files.js');
  return openFile(dir + name);
});

/** Kill agent processes left over from before a webview reload (their state is gone). */
export async function killOrphanAgents() {
  if (!isTauri) return;
  for (const p of (await invoke('proc_list')) ?? []) {
    if (p.tag === 'acp' || p.tag === 'acp-terminal') await invoke('proc_kill', { id: p.id }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Keys

defineKey({ keymaps: 'agent-mode-map', states: 'insert' }, {
  'TAB': 'agent-tab',
  'RET': 'agent-newline',
  'C-j': 'agent-newline',
});
defineKey({ keymaps: 'agent-mode-map', states: 'normal' }, {
  'RET': 'agent-return',
  'TAB': 'agent-toggle-thought',
  'S-TAB': 'agent-toggle-all-thoughts',
  'z a': 'agent-toggle-thought',
  'z A': 'agent-toggle-all-thoughts',
});
defineKey({ keymaps: 'agent-mode-map', states: ['normal', 'insert'] }, {
  'C-c t': 'agent-toggle-thought',
  'C-c T': 'agent-toggle-all-thoughts',
  'C-c': { label: 'agent' },
  'C-c C-c': 'agent-send',
  'C-c C-k': 'agent-cancel',
  'C-c m': 'agent-set-mode',
  'C-c M': 'select-model',
  'C-c n': 'agent-new-session',
  'C-c /': 'agent-slash-command',
  'C-c q': 'agent-view-queue',
  'C-c Q': 'agent-queue-prompt',
  'C-c s': 'agent-add-steer',
  'C-c S': 'agent-remove-steer',
  'C-c v': 'select-effort',
});
defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
  'a': { label: 'agent' },
  'a a': 'agent',
  'a A': 'agent-select',
  'a s': 'select-agent',
  'a f': 'agent-add-context',
  'a m': 'agent-set-mode',
  'a M': 'select-model',
  'a n': 'agent-new-session',
  'a r': 'agent-restart',
  'a t': 'agent-open-transcript',
  'a T': 'agent-browse-transcripts',
  'a v': 'select-effort',
  'a q': 'agent-view-queue',
  'a Q': 'agent-queue-prompt',
  'a S': 'agent-add-steer',
  'a R': 'agent-remove-steer',
});

