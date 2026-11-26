// The editor's MCP server: tools that let agents see and control Polymer.
//
// The HTTP server runs in Rust (127.0.0.1, bearer token); this module answers its
// tools/list and tools/call requests. Agents started with SPC a a get the server
// automatically. Other MCP clients can use it too: M-x mcp-connection-info.
//
// Add tools from init.js or a package:
//   defineMcpTool('word_count', {
//     description: 'Count words in a buffer',
//     inputSchema: { type: 'object', properties: { buffer: { type: 'string' } } },
//     handler: ({ buffer }) => String(getBuffer(buffer).getText().split(/\s+/).length),
//   })
// Commands defined with { mcp: true } or listed in mcp-commands are callable through run_command.

import { defcommand, defvar, getVarOr, allFunctions, functionInfo } from '../core/registry.js';
import { callInteractively } from '../core/command-loop.js';
import { bufferList, getBuffer, currentBuffer, findBufferVisiting } from '../core/buffer.js';
import { yesOrNo } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { invoke, createChannel, isTauri } from '../core/host.js';
import { evalString } from '../core/eval.js';
import { prin1 } from '../core/printer.js';
import { expandFileName, abbreviateFileName } from '../core/files.js';
import { addAgentMcpProvider } from '../agent/agent.js';

defvar('mcp-server-enabled', true, { doc: 'Run the editor\'s MCP server and give it to agents.' });
defvar('mcp-allow-eval', 'ask', { doc: 'The eval_js tool: "ask" (confirm each time), true (allow), or false (disabled).' });
defvar('mcp-allow-all-commands', false, { doc: 'When true, run_command may run any interactive command, not only allowed ones.' });
defvar('mcp-commands', ['save-buffer', 'git-status', 'git-refresh', 'split-window-right', 'split-window-below', 'delete-other-windows', 'balance-windows'], {
  doc: 'Commands agents may run with run_command, besides those defined with { mcp: true }.',
});
defvar('mcp-max-text', 200_000, { doc: 'Longest buffer text (characters) returned by get_buffer_text.' });

const tools = new Map(); // name -> { name, description, inputSchema, handler }

const commandAllowed = (f) => f?.command && (f.mcp || getVarOr('mcp-commands', [], null).includes(f.name) || getVarOr('mcp-allow-all-commands', false));
let info = null;          // { url, token }

/** Register (or replace) a tool. The handler returns a string, or an object (sent as JSON). */
export function defineMcpTool(name, { description = '', inputSchema = { type: 'object', properties: {} }, handler }) {
  tools.set(name, { name, description, inputSchema, handler });
  return name;
}

export const mcpTools = () => [...tools.values()];
export const mcpInfo = () => info;

// ---------------------------------------------------------------------------
// Answering the server

async function callTool(name, args) {
  const tool = tools.get(name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    const out = await tool.handler(args ?? {});
    const text = typeof out === 'string' ? out : JSON.stringify(out ?? null, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true };
  }
}

export async function handleMcpRequest(method, params) {
  if (method === 'tools/list') {
    return { tools: mcpTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (method === 'tools/call') return callTool(params?.name, params?.arguments);
  throw new Error(`Unsupported: ${method}`);
}

/** Start the server (or re-attach after a reload). Resolves to { url, token }. */
export async function startMcpServer() {
  if (!isTauri || !getVarOr('mcp-server-enabled', true)) return null;
  const channel = createChannel(async (ev) => {
    if (ev.type !== 'request') return;
    let response;
    try {
      response = { result: await handleMcpRequest(ev.method, ev.params) };
    } catch (e) {
      response = { error: { message: e?.message ?? String(e) } };
    }
    invoke('mcp_respond', { id: ev.id, response }).catch(() => {});
  });
  info = await invoke('mcp_start', { channel });
  return info;
}

// New agent sessions get the server.
addAgentMcpProvider(() => (info && getVarOr('mcp-server-enabled', true)
  ? { type: 'http', name: 'polymer', url: info.url, headers: [{ name: 'Authorization', value: `Bearer ${info.token}` }] }
  : null));

// ---------------------------------------------------------------------------
// Built-in tools

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

function findBuffer({ buffer, path }) {
  if (path) {
    const b = findBufferVisiting(expandFileName(path));
    if (!b) throw new Error(`No open buffer visits ${path}`);
    return b;
  }
  if (buffer) {
    const b = getBuffer(buffer);
    if (!b) throw new Error(`No buffer named ${buffer}`);
    return b;
  }
  return currentBuffer();
}

function selectionOf(b) {
  if (b.state !== 'visual' || !b.vim?.visual) return null;
  const a = b.vim.visual.anchor.pos;
  const p = b.point.pos;
  const from = Math.min(a, p);
  const to = Math.min(b.length, Math.max(a, p) + 1);
  return { text: b.getText(from, to), startLine: b.lineAt(from) + 1, endLine: b.lineAt(Math.max(from, to - 1)) + 1 };
}

defineMcpTool('list_buffers', {
  description: 'List the buffers open in the editor: name, file path, major mode, unsaved changes.',
  handler: () => bufferList().map((b) => ({ name: b.name, file: b.file ?? null, mode: b.mode, modified: !!(b.file && b.modified), lines: b.lineCount })),
});

defineMcpTool('get_editor_state', {
  description: 'What the user is looking at: the selected window\'s buffer, file, cursor line/column (1-based), and their selection if any.',
  handler: () => {
    const b = currentBuffer();
    const { line, col } = b.posAt(b.point.pos);
    return { buffer: b.name, file: b.file ?? null, mode: b.mode, line: line + 1, column: col + 1, selection: selectionOf(b), modified: !!(b.file && b.modified) };
  },
});

defineMcpTool('get_buffer_text', {
  description: 'Text of an open buffer, including unsaved edits. Identify it by buffer name or file path (default: the current buffer). Optional 1-based line range.',
  inputSchema: schema({ buffer: str('Buffer name'), path: str('File path of a buffer visiting it'), startLine: int('First line (1-based)'), endLine: int('Last line (inclusive)') }),
  handler: (args) => {
    const b = findBuffer(args);
    let text = b.getText();
    if (args.startLine || args.endLine) {
      const lines = text.split('\n');
      text = lines.slice(Math.max(0, (args.startLine ?? 1) - 1), args.endLine ?? lines.length).join('\n');
    }
    const max = getVarOr('mcp-max-text', 200_000);
    return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
  },
});

defineMcpTool('open_file', {
  description: 'Open a file in the editor for the user to see, optionally at a line (1-based). Opens in another window so the user keeps their place.',
  inputSchema: schema({ path: str('Absolute path, or relative to the current buffer\'s directory'), line: int('Line to show (1-based)') }, ['path']),
  handler: async ({ path, line }) => {
    const { openFile } = await import('../commands/files.js');
    const b = await openFile(expandFileName(path), { otherWindow: true });
    if (line) b.point.set(b.offsetAt(line - 1, 0));
    return `Opened ${abbreviateFileName(b.file)}${line ? ` at line ${line}` : ''}`;
  },
});

defineMcpTool('show_message', {
  description: 'Show a short message in the editor\'s echo area.',
  inputSchema: schema({ text: str('The message') }, ['text']),
  handler: ({ text }) => { message('%s', text); return 'shown'; },
});

defineMcpTool('list_commands', {
  description: 'Editor commands that run_command may run, with their documentation.',
  handler: () => allFunctions(commandAllowed).map((f) => ({ name: f.name, doc: f.doc.split('\n')[0] })),
});

defineMcpTool('run_command', {
  description: 'Run an editor command by name (see list_commands), as if the user invoked it.',
  inputSchema: schema({ name: str('Command name'), args: { type: 'array', description: 'Arguments (optional)', items: {} } }, ['name']),
  handler: async ({ name, args }) => {
    const f = functionInfo(name);
    if (!f?.command) throw new Error(`No command named ${name}`);
    if (!commandAllowed(f)) throw new Error(`${name} is not available to agents (add it to mcp-commands or define it with { mcp: true })`);
    const result = await callInteractively(name, args?.length ? { args } : {});
    return result === undefined ? `Ran ${name}` : prin1(result);
  },
});

defineMcpTool('eval_js', {
  description: 'Evaluate JavaScript in the editor (its whole API is in scope: currentBuffer(), defcommand, setq, ...). The user is asked to confirm unless they allowed it.',
  inputSchema: schema({ code: str('JavaScript to evaluate') }, ['code']),
  handler: async ({ code }) => {
    const allow = getVarOr('mcp-allow-eval', 'ask');
    if (allow === false) throw new Error('eval_js is disabled (mcp-allow-eval)');
    if (allow === 'ask') {
      const preview = code.length > 80 ? `${code.slice(0, 77)}…` : code;
      if (!(await yesOrNo(`Agent wants to run JavaScript: ${preview.replace(/\s+/g, ' ')} — allow?`))) throw new Error('The user declined');
    }
    return prin1(await evalString(code));
  },
});

// ---------------------------------------------------------------------------
// Commands

defcommand('mcp-connection-info', { doc: 'Show the editor MCP server\'s URL and token (to connect other MCP clients).' }, async () => {
  if (!info) throw new Error('The MCP server is not running');
  const { showHelp } = await import('../commands/help.js');
  showHelp([
    'Polymer MCP server (streamable HTTP)',
    '',
    `  URL:    ${info.url}`,
    `  Header: Authorization: Bearer ${info.token}`,
    '',
    'Agents started with SPC a a are connected automatically. For another client, e.g.:',
    `  claude mcp add --transport http polymer ${info.url} --header "Authorization: Bearer ${info.token}"`,
    '',
    'The token changes every time Polymer starts.',
    '',
    `Tools (${tools.size}):`,
    ...mcpTools().map((t) => `  ${t.name.padEnd(18)} ${t.description.split('.')[0]}`),
  ].join('\n'));
});

