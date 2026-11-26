// An ACP (Agent Client Protocol) client.
//
// Polymer is the client: it starts the agent process, speaks JSON-RPC over its stdio,
// and serves the agent's requests:
//   fs/read_text_file    from the editor's buffer when the file is open (unsaved edits
//                        included), else from disk
//   fs/write_text_file   into the open buffer (undoable) and saved, else to disk
//   terminal/*           commands run as processes; output is captured for the agent
//   session/request_permission   asked through the UI callback

import { invoke, createChannel, appInfo } from '../core/host.js';
import { findBufferVisiting } from '../core/buffer.js';
import {
  readTextFile, writeTextFile, makeDirectory, dirname, saveBuffer,
} from '../core/files.js';
import { runHooks } from '../core/registry.js';
import { undoBoundary } from '../core/undo.js';
import { JsonRpcConnection } from './jsonrpc.js';

export const PROTOCOL_VERSION = 1;

/**
 * Callbacks the UI provides:
 *   onUpdate(params)               session/update notifications
 *   requestPermission(params)      -> { outcome: { outcome: 'selected', optionId } | { outcome: 'cancelled' } }
 *   onExit(code)                   the agent process ended
 *   onStderr(text)                 agent diagnostics
 *   onTerminalOutput(terminalId)   a terminal's output changed (to redraw)
 */
export class AcpClient {
  constructor(def, ui) {
    this.def = def; // { command, args, env, cwd }
    this.ui = ui;
    this.procId = null;
    this.conn = null;
    this.agentCapabilities = {};
    this.authMethods = [];
    this.agentInfo = null;
    this.terminals = new Map(); // terminalId -> { procId, output, truncated, limit, exit, waiters }
    this.nextTerminal = 1;
    this.exited = false;
  }

  async start() {
    const conn = new JsonRpcConnection((line) => invoke('proc_write', { id: this.procId, data: line }), {
      onRequest: (method, params) => this.handleRequest(method, params),
      onNotification: (method, params) => {
        if (method === 'session/update') this.ui.onUpdate?.(params);
      },
      onInvalid: (line) => this.ui.onStderr?.(`${line}\n`),
    });
    this.conn = conn;
    const channel = createChannel((ev) => {
      if (ev.type === 'stdout') conn.feed(ev.data);
      else if (ev.type === 'stderr') this.ui.onStderr?.(ev.data);
      else if (ev.type === 'exit') {
        this.exited = true;
        conn.close(`Agent exited (${ev.code ?? 'signal'})`);
        for (const id of [...this.terminals.keys()]) this.releaseTerminal(id);
        this.ui.onExit?.(ev.code);
      }
    });
    this.procId = await invoke('proc_spawn', {
      options: { program: this.def.command, args: this.def.args ?? [], cwd: this.def.cwd, env: this.def.env, tag: 'acp' },
      channel,
    });
    const info = await appInfo();
    const res = await conn.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'polymer', title: 'Polymer', version: info.version ?? 'dev' },
    });
    this.agentCapabilities = res?.agentCapabilities ?? {};
    this.authMethods = res?.authMethods ?? [];
    this.agentInfo = res?.agentInfo ?? null;
    return res;
  }

  newSession(cwd, mcpServers = []) {
    return this.conn.request('session/new', { cwd, mcpServers });
  }

  loadSession(sessionId, cwd, mcpServers = []) {
    return this.conn.request('session/load', { sessionId, cwd, mcpServers });
  }

  authenticate(methodId) {
    return this.conn.request('authenticate', { methodId });
  }

  prompt(sessionId, prompt) {
    return this.conn.request('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId) {
    return this.conn.notify('session/cancel', { sessionId });
  }

  setMode(sessionId, modeId) {
    return this.conn.request('session/set_mode', { sessionId, modeId });
  }

  async kill() {
    for (const id of [...this.terminals.keys()]) this.releaseTerminal(id);
    if (this.procId !== null) await invoke('proc_kill', { id: this.procId }).catch(() => {});
    this.conn?.close('Agent stopped');
  }

  // -------------------------------------------------------------------------
  // Requests from the agent

  async handleRequest(method, params) {
    switch (method) {
      case 'session/request_permission':
        return this.ui.requestPermission ? this.ui.requestPermission(params) : { outcome: { outcome: 'cancelled' } };
      case 'fs/read_text_file':
        return { content: await readForAgent(params) };
      case 'fs/write_text_file':
        await writeForAgent(params);
        return null;
      case 'terminal/create':
        return { terminalId: await this.createTerminal(params) };
      case 'terminal/output': {
        const t = this.terminal(params.terminalId);
        return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
      }
      case 'terminal/wait_for_exit': {
        const t = this.terminal(params.terminalId);
        return t.exit ?? new Promise((resolve) => t.waiters.push(resolve));
      }
      case 'terminal/kill': {
        const t = this.terminal(params.terminalId);
        if (!t.exit) await invoke('proc_kill', { id: t.procId }).catch(() => {});
        return null;
      }
      case 'terminal/release':
        this.releaseTerminal(params.terminalId);
        return null;
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  terminal(id) {
    const t = this.terminals.get(id);
    if (!t) throw Object.assign(new Error(`Unknown terminal ${id}`), { code: -32602 });
    return t;
  }

  async createTerminal({ command, args = [], env = [], cwd, outputByteLimit }) {
    const id = `term-${this.nextTerminal++}`;
    // A bare command line runs through the shell; a program with arguments runs directly.
    const viaShell = !args.length && /\s/.test(command);
    const windows = navigator.platform?.startsWith('Win');
    const program = viaShell ? (windows ? 'cmd' : '/bin/sh') : command;
    const argv = viaShell ? (windows ? ['/C', command] : ['-c', command]) : args;
    const t = { id, procId: null, output: '', truncated: false, limit: outputByteLimit ?? null, exit: null, waiters: [], command: viaShell ? command : [command, ...args].join(' ') };
    this.terminals.set(id, t);
    const append = (data) => {
      t.output += data;
      if (t.limit && t.output.length > t.limit) {
        t.output = t.output.slice(t.output.length - t.limit);
        t.truncated = true;
      }
      this.ui.onTerminalOutput?.(id);
    };
    const channel = createChannel((ev) => {
      if (ev.type === 'stdout' || ev.type === 'stderr') append(ev.data);
      else if (ev.type === 'exit') {
        t.exit = { exitCode: ev.code ?? null, signal: ev.code === null ? 'killed' : null };
        for (const w of t.waiters.splice(0)) w(t.exit);
        this.ui.onTerminalOutput?.(id);
      }
    });
    t.procId = await invoke('proc_spawn', {
      options: { program, args: argv, cwd: cwd ?? this.def.cwd, env: Object.fromEntries((env ?? []).map((e) => [e.name, e.value])), tag: 'acp-terminal' },
      channel,
    });
    return id;
  }

  releaseTerminal(id) {
    const t = this.terminals.get(id);
    if (!t) return;
    if (!t.exit) invoke('proc_kill', { id: t.procId }).catch(() => {});
    t.released = true;
  }
}

// ---------------------------------------------------------------------------
// File access for agents

function sliceLines(text, line, limit) {
  if (!line && !limit) return text;
  const lines = text.split('\n');
  const start = Math.max(0, (line ?? 1) - 1);
  return lines.slice(start, limit ? start + limit : undefined).join('\n');
}

export async function readForAgent({ path, line, limit }) {
  const p = path.replace(/\\/g, '/');
  const b = findBufferVisiting(p);
  // Only text buffers stand in for their file (an image buffer has no text).
  const text = b && !b.binary ? b.getText() : (await readTextFile(p)).text;
  return sliceLines(text, line, limit);
}

export async function writeForAgent({ path, content }) {
  const p = path.replace(/\\/g, '/');
  const b = findBufferVisiting(p);
  if (b && !b.binary) {
    // Through the buffer: undoable, keeps the cursor's line, then saved.
    // Its own undo step, separate from whatever you were typing.
    const { line, col } = b.posAt(b.point.pos);
    undoBoundary(b);
    b.replaceText(0, b.length, content, { inhibitReadOnly: true });
    undoBoundary(b);
    b.point.set(b.offsetAt(line, col));
    await saveBuffer(b, { confirm: async () => true });
  } else {
    await makeDirectory(dirname(p));
    await writeTextFile(p, content, false);
  }
  runHooks('agent-file-written-hook', p);
}
