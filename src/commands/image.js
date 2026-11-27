// Image buffers: PNG, JPEG, GIF (animated), WebP, AVIF, BMP, ICO and SVG files open as
// pictures instead of text.
//
//   + / =   zoom in        -   zoom out        0   fit the window (default)   1   actual size
//   r / R   rotate right / left                n / p   next / previous image in the directory
//   h j k l / arrows   pan when zoomed (the mouse wheel scrolls; C-wheel zooms)
//   g r     reload from disk                   q   quit
//
// SVGs are shown as images, so scripts inside them never run.

import { defcommand, defvar, getVarOr, addHook } from '../core/registry.js';
import { defineMajorMode, setMajorMode } from '../core/modes.js';
import { defineKey } from '../core/keymap.js';
import { getBufferCreate, generateNewBufferName, currentBuffer, renameBuffer } from '../core/buffer.js';
import { selectedWindow } from '../core/window.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { invoke } from '../core/host.js';
import { scheduleRedisplay } from '../core/redisplay.js';
import {
  defineFileHandler, pathInfo, listDirectory, dirname, basename, extension, abbreviateFileName,
} from '../core/files.js';

defvar('image-zoom-step', 1.25, { doc: 'Factor for each zoom in/out step.' });
defvar('image-enlarge-to-fit', false, { doc: 'When true, fitting also enlarges images smaller than the window.' });

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};

export const isImageFile = (path) => Object.prototype.hasOwnProperty.call(MIME, extension(path).toLowerCase());
/** The MIME type of an image file, from its extension (null if it isn't one). */
export const imageMimeType = (path) => (isImageFile(path) ? MIME[extension(path).toLowerCase()] : null);

const userError = (msg) => new PolymerError('user-error', msg);

defineMajorMode('image-mode', {
  parent: 'special-mode',
  lighter: 'Image',
  doc: 'An image. + / - zoom, 0 fit, 1 actual size, r / R rotate, n / p next / previous image, h j k l pan, g r reload, q quit.',
});

function humanSize(n) {
  if (n < 1024) return `${n}B`;
  const units = ['K', 'M', 'G'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

// ---------------------------------------------------------------------------
// Loading

async function load(b, path) {
  const im = b.image;
  const bytes = new Uint8Array(await invoke('read_binary_file', { path }));
  const info = await pathInfo(path);
  if (im.url) URL.revokeObjectURL(im.url);
  Object.assign(im, {
    path,
    url: URL.createObjectURL(new Blob([bytes], { type: MIME[extension(path).toLowerCase()] ?? 'application/octet-stream' })),
    bytes: bytes.length,
    natural: null,
    error: null,
    zoom: null,
    rotation: 0,
  });
  b.file = path;
  b.fileInfo = { crlf: false, mtimeMs: info.mtimeMs };
  b.modified = false;
  b.locals.set('default-directory', dirname(path));
  b.touch();
}

/** Open an image file in a new image buffer. */
export async function openImage(path) {
  const b = getBufferCreate(generateNewBufferName(basename(path)));
  setMajorMode(b, 'image-mode');
  b.binary = true;      // no text: agents and tools read the file itself
  b.undoEnabled = false;
  b.image = { path, url: null, bytes: 0, natural: null, error: null, zoom: null, rotation: 0, displayScale: 1 };
  b.customRenderer = renderImage;
  b.modeLineInfo = () => {
    const im = b.image;
    if (im.error) return 'cannot display';
    if (!im.natural) return 'loading…';
    const pct = `${Math.round(im.displayScale * 100)}%${im.zoom === null ? ' fit' : ''}`;
    return `${im.natural.w}×${im.natural.h}  ${pct}${im.rotation ? `  ${im.rotation}°` : ''}  ${humanSize(im.bytes)}`;
  };
  b.revertFunction = async (buf) => { await load(buf, buf.file); message('Reloaded %s', basename(buf.file)); };
  b.onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return false; // plain wheel scrolls the image
    zoomBy(b, e.deltaY < 0 ? 1 : -1);
    return true;
  };
  await load(b, path);
  return b;
}

defineFileHandler('image', { match: isImageFile, open: openImage });

addHook('kill-buffer-hook', function imageRevokeUrl(b) {
  if (b.image?.url) URL.revokeObjectURL(b.image.url);
});

// ---------------------------------------------------------------------------
// Rendering

function renderImage(win, el) {
  const b = win.buffer;
  const im = b.image;
  // Build (or rebuild for a new file) the stage and the <img>.
  let stage = el.firstChild;
  if (!stage || stage.dataset.url !== im.url) {
    stage = document.createElement('div');
    stage.className = 'image-stage';
    stage.dataset.url = im.url ?? '';
    const img = document.createElement('img');
    img.alt = basename(im.path);
    img.draggable = false;
    img.addEventListener('load', () => {
      // SVGs without a size report 0; fall back to the browser's default object size.
      im.natural = { w: img.naturalWidth || 300, h: img.naturalHeight || 150 };
      win.customState = null;
      b.touch();
    });
    img.addEventListener('error', () => {
      im.error = true;
      stage.replaceChildren(Object.assign(document.createElement('div'), { className: 'image-error', textContent: `Cannot display ${basename(im.path)}` }));
      b.touch();
    });
    if (im.url) img.src = im.url;
    stage.appendChild(img);
    el.replaceChildren(stage);
    win.customState = null;
  }
  if (!im.natural || im.error) return;
  const W = el.clientWidth;
  const H = el.clientHeight;
  const key = `${im.zoom}|${im.rotation}|${W}x${H}|${im.natural.w}x${im.natural.h}`;
  if (win.customState === key) return;
  win.customState = key;
  const turned = im.rotation % 180 !== 0;
  const { w: nw, h: nh } = im.natural;
  const rw = turned ? nh : nw;
  const rh = turned ? nw : nh;
  const pad = 16;
  const fit = Math.min((W - pad) / rw, (H - pad) / rh);
  const scale = im.zoom ?? (getVarOr('image-enlarge-to-fit', false, b) ? fit : Math.min(1, fit));
  im.displayScale = Math.max(0.01, scale);
  stage.style.width = `${rw * im.displayScale}px`;
  stage.style.height = `${rh * im.displayScale}px`;
  const img = stage.querySelector('img');
  img.style.width = `${nw * im.displayScale}px`;
  img.style.height = `${nh * im.displayScale}px`;
  img.style.transform = `translate(-50%, -50%) rotate(${im.rotation}deg)`;
}

// ---------------------------------------------------------------------------
// Commands

function requireImage() {
  const b = currentBuffer();
  if (!b.image) throw userError('Not an image buffer');
  return b;
}

function zoomBy(b, steps) {
  const im = b.image;
  const step = getVarOr('image-zoom-step', 1.25, b);
  // Build on the last requested zoom, not the last drawn one, so quick repeats all count.
  const base = im.zoom ?? im.displayScale;
  im.zoom = Math.max(0.02, Math.min(32, base * step ** steps));
  im.displayScale = im.zoom;
  b.touch();
}

defcommand('image-zoom-in', { doc: 'Zoom in (+ or =).' }, () => zoomBy(requireImage(), 1));
defcommand('image-zoom-out', { doc: 'Zoom out (-).' }, () => zoomBy(requireImage(), -1));
defcommand('image-fit', { doc: 'Fit the image in the window (0).' }, () => { const b = requireImage(); b.image.zoom = null; b.touch(); });
defcommand('image-actual-size', { doc: 'Show the image at its actual size (1).' }, () => { const b = requireImage(); b.image.zoom = 1; b.touch(); });
defcommand('image-rotate-right', { doc: 'Rotate 90° clockwise (r).' }, () => { const b = requireImage(); b.image.rotation = (b.image.rotation + 90) % 360; b.touch(); });
defcommand('image-rotate-left', { doc: 'Rotate 90° counter-clockwise (R).' }, () => { const b = requireImage(); b.image.rotation = (b.image.rotation + 270) % 360; b.touch(); });

function pan(dx, dy) {
  const el = selectedWindow()?.customEl;
  if (!el) return;
  el.scrollLeft += dx;
  el.scrollTop += dy;
}

defcommand('image-pan-left', { doc: 'Pan left (h).' }, () => pan(-60, 0));
defcommand('image-pan-right', { doc: 'Pan right (l).' }, () => pan(60, 0));
defcommand('image-pan-up', { doc: 'Pan up (k).' }, () => pan(0, -60));
defcommand('image-pan-down', { doc: 'Pan down (j).' }, () => pan(0, 60));

async function neighbour(b, dir) {
  const d = dirname(b.image.path);
  const images = (await listDirectory(d)).filter((e) => !e.isDir && isImageFile(e.name)).map((e) => e.name)
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
  if (images.length < 2) throw userError('No other images in this directory');
  const i = images.indexOf(basename(b.image.path));
  return d + images[(i + dir + images.length) % images.length];
}

async function step(dir) {
  const b = requireImage();
  const next = await neighbour(b, dir);
  await load(b, next);
  const name = basename(next);
  if (b.name !== name) renameBuffer(b, generateNewBufferName(name));
  scheduleRedisplay();
  message('%s', abbreviateFileName(next));
}

defcommand('image-next-file', { doc: 'Show the next image in the same directory (n).' }, () => step(1));
defcommand('image-previous-file', { doc: 'Show the previous image in the same directory (p).' }, () => step(-1));

defineKey({ keymaps: 'image-mode-map', states: 'normal' }, {
  '+': 'image-zoom-in',
  '=': 'image-zoom-in',
  '-': 'image-zoom-out',
  '0': 'image-fit',
  '1': 'image-actual-size',
  'r': 'image-rotate-right',
  'R': 'image-rotate-left',
  'n': 'image-next-file',
  'p': 'image-previous-file',
  'h': 'image-pan-left',
  'l': 'image-pan-right',
  'k': 'image-pan-up',
  'j': 'image-pan-down',
  '<left>': 'image-pan-left',
  '<right>': 'image-pan-right',
  '<up>': 'image-pan-up',
  '<down>': 'image-pan-down',
  'g r': 'revert-buffer',
});
