// Agents over ACP (Claude Code by default).

import { defineBufferSerializer } from '../persp/persp.js';
import { openAgent } from './agent.js';

// Agent buffers come back with their perspective as a fresh session in the same directory.
defineBufferSerializer('agent', {
  serialize: (b) => (b.agent ? { name: b.agent.name, cwd: b.agent.cwd } : null),
  restore: (data) => openAgent({ name: data.name, cwd: data.cwd, display: false }),
});
