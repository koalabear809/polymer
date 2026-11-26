// Git (magit-style).

import './git.js';
import './status.js';
import './ops.js';
import './keys.js';
import { defineBufferSerializer } from '../persp/persp.js';
import { statusBuffer } from './status.js';

// Status buffers come back with their perspective.
defineBufferSerializer('git-status', {
  serialize: (b) => (b.mode === 'git-status-mode' && b.git?.root ? { root: b.git.root } : null),
  restore: (data) => statusBuffer(data.root),
});
