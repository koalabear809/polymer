// JSON-RPC 2.0 over newline-delimited JSON (the ACP transport).

export class JsonRpcConnection {
  /**
   * send(text): writes one message (a line) to the peer.
   * handlers: { onRequest(method, params) -> result | Promise, onNotification(method, params),
   *             onInvalid(line) }
   */
  constructor(send, handlers = {}) {
    this.send = send;
    this.handlers = handlers;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
  }

  /** Feed raw output from the peer. */
  feed(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.handleLine(line);
    }
  }

  write(msg) {
    return Promise.resolve(this.send(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`));
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.onInvalid?.(line);
      return;
    }
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        // ACP agents put the useful part in error.data.details ("Internal error" alone says nothing).
        const details = msg.error.data?.details ?? (typeof msg.error.data === 'string' ? msg.error.data : null);
        const err = new Error(details ? `${msg.error.message ?? 'Request failed'}: ${details}` : (msg.error.message ?? 'Request failed'));
        err.code = msg.error.code;
        err.data = msg.error.data;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method !== undefined && msg.id !== undefined) {
      this.respond(msg);
    } else if (msg.method !== undefined) {
      try { this.handlers.onNotification?.(msg.method, msg.params); } catch (e) { console.error('notification handler:', e); }
    }
  }

  async respond(msg) {
    try {
      if (!this.handlers.onRequest) throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
      const result = await this.handlers.onRequest(msg.method, msg.params);
      await this.write({ id: msg.id, result: result ?? null });
    } catch (e) {
      await this.write({ id: msg.id, error: { code: typeof e?.code === 'number' ? e.code : -32603, message: e?.message ?? String(e) } });
    }
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    this.write({ id, method, params }).catch((e) => {
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.reject(e);
    });
    return promise;
  }

  notify(method, params) {
    if (this.closed) return Promise.resolve();
    return this.write({ method, params });
  }

  /** Fail every pending request (the peer went away). */
  close(reason = 'Connection closed') {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
