// File tree: a directory tree browser in a buffer.
//
// Similar to dired but shows a tree view. Navigate with j/k, RET opens files/toggles
// directories, q closes the buffer, g r refreshes.

import { defcommand, defvar, getVarOr, setq } from '../core/registry.js';
import { defineMajorMode, setMajorMode } from '../core/modes.js';
import { defineKey } from '../core/keymap.js';
import { getBufferCreate, currentBuffer, bufferList } from '../core/buffer.js';
import { selectedWindow, setWindowBuffer, windowList } from '../core/window.js';
import { message } from '../core/echo.js';
import { listDirectory, expandFileName, asDirectory, dirname, pathInfo, findFileNoselect } from '../core/files.js';
import { PolymerError } from '../core/errors.js';
import { createSidebar, toggleSidebar, updateSidebar, getSidebar } from '../core/sidebar.js';

defvar('filetree-show-hidden', false, { doc: 'Show files whose names start with "." in file tree.' });
defvar('filetree-indent', 2, { doc: 'Indentation level in spaces for nested directories.' });

const userError = (msg) => new PolymerError('user-error', msg);

defineMajorMode('filetree-mode', {
  parent: 'special-mode',
  lighter: 'FileTree',
  doc: 'Directory tree browser. RET open file/toggle directory, TAB toggle directory, g r refresh, g h toggle hidden files.',
});

// Store tree state: { path -> { expanded: bool, entries: [], level: num } }
const treeState = new Map();
let rootPath = null;

// ---------------------------------------------------------------------------
// Rendering

async function loadDirectory(path, level) {
  try {
    const entries = await listDirectory(path);
    const showHidden = getVarOr('filetree-show-hidden', false);
    const filtered = showHidden ? entries : entries.filter(e => !e.name.startsWith('.'));
    
    treeState.set(path, {
      expanded: treeState.get(path)?.expanded ?? false,
      entries: filtered,
      level,
    });
    
    return filtered;
  } catch (e) {
    console.error('Error loading directory:', path, e);
    return [];
  }
}

async function buildTree(path, level = 0) {
  const nodes = [];
  
  const state = treeState.get(path);
  if (!state) return nodes;
  
  for (const entry of state.entries) {
    const fullPath = path + (path.endsWith('/') ? '' : '/') + entry.name;
    
    if (entry.isDir) {
      const expanded = treeState.get(fullPath)?.expanded ?? false;
      nodes.push({ 
        name: entry.name, 
        path: fullPath, 
        isDir: true, 
        level, 
        expanded 
      });
      
      // If expanded, recurse
      if (expanded) {
        const children = await buildTree(fullPath, level + 1);
        nodes.push(...children);
      }
    } else {
      nodes.push({ 
        name: entry.name, 
        path: fullPath, 
        isDir: false, 
        level 
      });
    }
  }
  
  return nodes;
}

async function renderFileTree(el) {
  // Load root if needed
  if (!treeState.has(rootPath)) {
    await loadDirectory(rootPath, 0);
    treeState.set(rootPath, { ...treeState.get(rootPath), expanded: true });
  }
  
  const nodes = await buildTree(rootPath);
  
  // Clear existing content
  el.innerHTML = '';
  
  // Add header
  const header = document.createElement('div');
  header.className = 'filetree-header';
  header.textContent = `File Tree: ${rootPath}`;
  header.style.padding = '8px';
  header.style.borderBottom = '1px solid var(--border)';
  el.appendChild(header);
  
  // Add tree nodes
  const tree = document.createElement('div');
  tree.className = 'filetree-tree';
  tree.style.padding = '4px';
  
  for (const node of nodes) {
    const nodeEl = document.createElement('div');
    nodeEl.className = 'filetree-node';
    nodeEl.style.paddingLeft = `${node.level * 16 + 4}px`;
    nodeEl.style.cursor = 'pointer';
    nodeEl.style.padding = '2px 4px';
    nodeEl.dataset.path = node.path;
    nodeEl.dataset.isDir = node.isDir ? 'true' : 'false';
    
    if (node.isDir) {
      const marker = node.expanded ? '▼' : '▶';
      nodeEl.innerHTML = `<span class="filetree-marker">${marker}</span> <span class="filetree-directory">${node.name}/</span>`;
    } else {
      nodeEl.innerHTML = `<span style="margin-left: 1em"></span><span class="filetree-file">${node.name}</span>`;
    }
    
    // Hover effect
    nodeEl.addEventListener('mouseenter', () => {
      nodeEl.style.backgroundColor = 'var(--bg-hl)';
    });
    nodeEl.addEventListener('mouseleave', () => {
      nodeEl.style.backgroundColor = '';
    });
    
    // Click handler
    nodeEl.addEventListener('click', async () => {
      if (node.isDir) {
        await toggleDirectory(node.path);
        updateSidebar('filetree');
      } else {
        await openFile(node.path);
      }
    });
    
    tree.appendChild(nodeEl);
  }
  
  el.appendChild(tree);
}

// ---------------------------------------------------------------------------
// Commands

async function toggleDirectory(path) {
  const state = treeState.get(path);
  if (!state) {
    // Load it first
    const parentPath = dirname(path);
    const parentState = treeState.get(parentPath);
    if (parentState) {
      const level = parentState.level + 1;
      await loadDirectory(path, level);
    }
  }
  
  const newState = treeState.get(path);
  if (newState) {
    newState.expanded = !newState.expanded;
  }
}

async function openFile(path) {
  const fileBuf = await findFileNoselect(path);
  const targetWin = windowList().find(w => !w.buffer.name.startsWith('*Sidebar:')) || selectedWindow();
  setWindowBuffer(targetWin, fileBuf);
}

defcommand('filetree-refresh', { doc: 'Refresh the file tree.' }, async () => {
  treeState.clear();
  updateSidebar('filetree');
});

defcommand('filetree-toggle-hidden', { doc: 'Toggle showing hidden files.' }, async () => {
  const current = getVarOr('filetree-show-hidden', false);
  setq('filetree-show-hidden', !current);
  treeState.clear();
  updateSidebar('filetree');
  message('Hidden files %s', !current ? 'shown' : 'hidden');
});

// ---------------------------------------------------------------------------
// Sidebar management

async function initFileTree(path) {
  const root = asDirectory(expandFileName(path ?? getVarOr('default-directory', '/')));
  const info = await pathInfo(root);
  if (!info.isDir) throw userError(`Not a directory: ${root}`);
  
  rootPath = root;
  treeState.clear();
  
  // Create the sidebar
  createSidebar('filetree', {
    side: 'left',
    width: 300,
    render: renderFileTree,
    onKey: handleFileTreeKey,
    bufferName: '*Sidebar: FileTree*',
    modeName: 'filetree-mode',
  });
}

function handleFileTreeKey(event) {
  const key = event.key;
  
  if (key === 'g') {
    // Wait for next key
    const handleSecond = (e) => {
      if (e.key === 'r') {
        e.preventDefault();
        treeState.clear();
        updateSidebar('filetree');
      } else if (e.key === 'h') {
        e.preventDefault();
        const current = getVarOr('filetree-show-hidden', false);
        setq('filetree-show-hidden', !current);
        treeState.clear();
        updateSidebar('filetree');
        message('Hidden files %s', !current ? 'shown' : 'hidden');
      }
      document.removeEventListener('keydown', handleSecond);
    };
    document.addEventListener('keydown', handleSecond);
    return true;
  }
  
  return false;
}

defcommand('toggle-filetree', { doc: 'Toggle the file tree sidebar.' }, async () => {
  const sidebar = getSidebar('filetree');
  if (!sidebar) {
    await initFileTree();
  }
  toggleSidebar('filetree');
});
