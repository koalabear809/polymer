// Sidebar API: manage persistent sidebars that can be toggled and are keyboard-accessible.
//
// Sidebars are fixed panels on the left or right side of the editor. Each sidebar has:
// - A DOM element for rendering custom content
// - A hidden buffer for keyboard navigation
// - Event handlers that sync between DOM and buffer
// - Toggle state that persists

import { defvar, getVarOr, setq } from './registry.js';
import { getBufferCreate } from './buffer.js';
import { setMajorMode } from './modes.js';
import { scheduleRedisplay } from './redisplay.js';

defvar('sidebar-width', 300, { doc: 'Default width of sidebars in pixels.' });

const sidebars = new Map(); // id -> { el, buffer, side, width, visible, renderFn, keyHandler }

/**
 * Create or get a sidebar.
 * 
 * @param {string} id - Unique identifier for this sidebar
 * @param {Object} options
 * @param {'left'|'right'} options.side - Which side to show the sidebar (default: 'left')
 * @param {number} options.width - Width in pixels (default: from sidebar-width var)
 * @param {function} options.render - Function called to render sidebar content: (sidebarEl) => void
 * @param {function} options.onKey - Optional key handler: (key, event) => boolean (return true to prevent default)
 * @param {string} options.bufferName - Name for the hidden buffer (default: `*Sidebar: ${id}*`)
 * @param {string} options.modeName - Major mode for the buffer (default: 'special-mode')
 * @returns {Object} Sidebar object
 */
export function createSidebar(id, options = {}) {
  if (sidebars.has(id)) {
    return sidebars.get(id);
  }
  
  const {
    side = 'left',
    width = getVarOr('sidebar-width', 300),
    render = null,
    onKey = null,
    bufferName = `*Sidebar: ${id}*`,
    modeName = 'special-mode',
  } = options;
  
  // Create DOM element
  const el = document.createElement('div');
  el.className = `sidebar sidebar-${side}`;
  el.id = `sidebar-${id}`;
  el.style.width = `${width}px`;
  el.style.display = 'none';
  el.setAttribute('tabindex', '-1');
  
  // Add to frame
  const frame = document.getElementById('frame');
  if (side === 'left') {
    frame.prepend(el);
  } else {
    frame.appendChild(el);
  }
  
  // Create hidden buffer for keyboard navigation
  const buffer = getBufferCreate(bufferName);
  setMajorMode(buffer, modeName);
  buffer.undoEnabled = false;
  buffer.locals.set('display-line-numbers', false);
  
  // Track sidebar
  const sidebar = {
    id,
    el,
    buffer,
    side,
    width,
    visible: false,
    renderFn: render,
    keyHandler: onKey,
  };
  
  sidebars.set(id, sidebar);
  
  // Set up keyboard focus handling
  el.addEventListener('keydown', (e) => {
    if (onKey && onKey(e.key, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  
  // Initial render
  if (render) {
    render(el);
  }
  
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
  
  if (sidebar.visible) return;
  
  // Show sidebar
  sidebar.el.style.display = 'block';
  sidebar.visible = true;
  
  // Adjust windows container to make room
  const windowsEl = document.getElementById('windows');
  const currentMargin = parseInt(windowsEl.style.marginLeft || '0');
  const currentMarginRight = parseInt(windowsEl.style.marginRight || '0');
  
  if (sidebar.side === 'left') {
    windowsEl.style.marginLeft = `${currentMargin + sidebar.width}px`;
  } else {
    windowsEl.style.marginRight = `${currentMarginRight + sidebar.width}px`;
  }
  
  setq(`${id}-visible`, true);
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
  
  if (!sidebar.visible) return;
  
  // Hide sidebar
  sidebar.el.style.display = 'none';
  sidebar.visible = false;
  
  // Restore windows container
  const windowsEl = document.getElementById('windows');
  const currentMargin = parseInt(windowsEl.style.marginLeft || '0');
  const currentMarginRight = parseInt(windowsEl.style.marginRight || '0');
  
  if (sidebar.side === 'left') {
    windowsEl.style.marginLeft = `${Math.max(0, currentMargin - sidebar.width)}px`;
  } else {
    windowsEl.style.marginRight = `${Math.max(0, currentMarginRight - sidebar.width)}px`;
  }
  
  setq(`${id}-visible`, false);
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
  
  if (sidebar.visible) {
    hideSidebar(id);
  } else {
    showSidebar(id);
  }
}

/**
 * Update sidebar content by calling its render function.
 * @param {string} id - Sidebar identifier
 */
export function updateSidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar || !sidebar.renderFn) return;
  
  sidebar.renderFn(sidebar.el);
}

/**
 * Check if a sidebar is visible.
 * @param {string} id - Sidebar identifier
 * @returns {boolean}
 */
export function isSidebarVisible(id) {
  const sidebar = sidebars.get(id);
  return sidebar ? sidebar.visible : false;
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
  
  if (sidebar.visible) {
    hideSidebar(id);
  }
  
  sidebar.el.remove();
  sidebars.delete(id);
}

/**
 * Focus a sidebar (gives it keyboard focus).
 * @param {string} id - Sidebar identifier
 */
export function focusSidebar(id) {
  const sidebar = sidebars.get(id);
  if (!sidebar || !sidebar.visible) return;
  
  sidebar.el.focus();
}
