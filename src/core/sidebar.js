// Sidebar API: manage persistent sidebars that display buffers.
//
// Sidebars are pinned windows that split from the root.
// They display regular Polymer buffers (like dired) in a persistent window.

import { defvar, getVarOr, setq } from './registry.js';
import { splitWindow, deleteWindow, selectedWindow, selectWindow, setWindowBuffer, windowList } from './window.js';
import { scheduleRedisplay } from './redisplay.js';

defvar('sidebar-width', 300, { doc: 'Default width of sidebars in columns (characters).' });

const sidebars = new Map(); // id -> { window, side, buffer }

/**
 * Create or get a sidebar that displays a buffer.
 * 
 * @param {string} id - Unique identifier for this sidebar
 * @param {Buffer} buffer - The buffer to display in the sidebar
 * @param {Object} options
 * @param {'left'|'right'} options.side - Which side to show the sidebar (default: 'left')
 * @returns {Object} Sidebar object
 */
export function createSidebar(id, buffer, options = {}) {
  if (sidebars.has(id)) {
    const sidebar = sidebars.get(id);
    // Update buffer if different
    if (sidebar.buffer !== buffer) {
      setWindowBuffer(sidebar.window, buffer);
      sidebar.buffer = buffer;
    }
    return sidebar;
  }
  
  const {
    side = 'left',
  } = options;
  
  // Track sidebar (window will be created when shown)
  const sidebar = {
    id,
    window: null,
    side,
    buffer,
  };
  
  sidebars.set(id, sidebar);
  
  return sidebar;
}

/**
 * Show a sidebar.
 * @param {string} id - Sidebar identifier
 */
export function showSidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar) {
    console.error(`Sidebar not found: ${id}`);
    return;
  }
  
  if (sidebar.window && sidebar.window.live) {
    // Already visible, just select it
    selectWindow(sidebar.window);
    return;
  }
  
  // Get the leftmost/rightmost window to split from
  const windows = windowList();
  let targetWindow = windows[sidebar.side === 'left' ? 0 : windows.length - 1];
  
  // Split the window (splitWindow only supports 'below' and 'right')
  // For left sidebar, we split right and select the original window
  const newWin = splitWindow(targetWindow, 'right');
  
  let sidebarWin;
  if (sidebar.side === 'left') {
    // We want the new window to be the sidebar, but splitWindow creates it on the right
    // So we need to swap: set the buffer on the original window and use it as sidebar
    sidebarWin = targetWindow;
    // Restore the buffer to the new window
    setWindowBuffer(newWin, targetWindow.buffer);
  } else {
    sidebarWin = newWin;
  }
  
  // Set the buffer in the sidebar window
  setWindowBuffer(sidebarWin, sidebar.buffer);
  
  // Mark as sidebar
  sidebarWin.isSidebar = true;
  sidebarWin.sidebarId = id;
  
  // Store the window
  sidebar.window = sidebarWin;
  
  // Select it
  selectWindow(sidebarWin);
  
  scheduleRedisplay();
}

/**
 * Hide a sidebar.
 * @param {string} id - Sidebar identifier
 */
export function hideSidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar) {
    console.error(`Sidebar not found: ${id}`);
    return;
  }
  
  if (!sidebar.window || !sidebar.window.live) return;
  
  // Delete the window
  deleteWindow(sidebar.window);
  sidebar.window = null;
  
  scheduleRedisplay();
}

/**
 * Toggle a sidebar's visibility.
 * @param {string} id - Sidebar identifier
 */
export function toggleSidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar) {
    console.error(`Sidebar not found: ${id}`);
    return;
  }
  
  if (sidebar.window && sidebar.window.live) {
    hideSidebar(id);
  } else {
    showSidebar(id);
  }
}

/**
 * Update sidebar (triggers redisplay).
 * @param {string} id - Sidebar identifier
 */
export function updateSidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar) return;
  
  scheduleRedisplay();
}

/**
 * Check if a sidebar is visible.
 * @param {string} id - Sidebar identifier
 * @returns {boolean}
 */
export function isSidebarVisible(id) {
  const sidebar = sidebars.get(id);
  return sidebar && sidebar.window && sidebar.window.live;
}

/**
 * Get a sidebar by id.
 * @param {string} id - Sidebar identifier
 * @returns {Object|null}
 */
export function getSidebar(id) {
  return sidebars.get(id) || null;
}

/**
 * Remove a sidebar completely.
 * @param {string} id - Sidebar identifier
 */
export function destroySidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar) return;
  
  if (sidebar.window && sidebar.window.live) {
    hideSidebar(id);
  }
  
  sidebars.delete(id);
}

/**
 * Focus a sidebar (selects its window).
 * @param {string} id - Sidebar identifier
 */
export function focusSidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar || !sidebar.window || !sidebar.window.live) return;
  
  selectWindow(sidebar.window);
}

/**
 * Get a visible sidebar in the given direction from the selected window.
 * @param {'left'|'right'} direction - Direction to check
 * @returns {Object|null} Sidebar object or null
 */
export function sidebarInDirection(direction) {
  for (const [id, sidebar] of sidebars) {
    if (sidebar.window && sidebar.window.live && sidebar.side === direction) {
      return sidebar;
    }
  }
  return null;
}

/**
 * Check if the selected window is a sidebar.
 * @returns {Object|null} The focused sidebar or null
 */
export function getFocusedSidebar() {
  const sel = selectedWindow();
  if (!sel) return null;
  
  for (const [id, sidebar] of sidebars) {
    if (sidebar.window === sel) {
      return sidebar;
    }
  }
  return null;
}
