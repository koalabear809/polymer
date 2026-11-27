// File tree: a dired sidebar.
//
// Toggle with SPC f t.
// Just uses dired in a sidebar - all dired keybindings work.

import { defcommand, getVarOr } from '../core/registry.js';
import { getBufferCreate } from '../core/buffer.js';
import { createSidebar, toggleSidebar, getSidebar } from '../core/sidebar.js';
import { asDirectory, expandFileName } from '../core/files.js';
import { dired } from './dired.js';

async function ensureFileTreeBuffer() {
  const sidebar = getSidebar('filetree');
  if (sidebar) {
    return sidebar.buffer;
  }
  
  // Get current directory
  const dir = asDirectory(expandFileName(getVarOr('default-directory', '/')));
  
  // Create a dired buffer (don't display it yet)
  const buffer = await dired(dir, { display: false });
  
  // Create sidebar with the dired buffer
  createSidebar('filetree', buffer, {
    side: 'left',
  });
  
  return buffer;
}

defcommand('toggle-filetree', { doc: 'Toggle the file tree sidebar (dired).' }, async () => {
  const sidebar = getSidebar('filetree');
  if (!sidebar) {
    await ensureFileTreeBuffer();
  }
  toggleSidebar('filetree');
});
