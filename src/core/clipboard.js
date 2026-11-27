// The system clipboard. In the app it goes through the backend (the webview's
// navigator.clipboard can refuse reads on Windows and fails outside a user gesture);
// in a plain browser it falls back to navigator.clipboard.

import { invoke, isTauri } from './host.js';

/** True on macOS (where Cmd, not Ctrl, is the clipboard modifier). */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The clipboard's text ('' if none). */
export async function readClipboardText() {
  const text = isTauri ? await invoke('clipboard_read_text') : await navigator.clipboard?.readText?.();
  return (text ?? '').replace(/\r\n?/g, '\n');
}

export async function writeClipboardText(text) {
  if (isTauri) return invoke('clipboard_write_text', { text });
  return navigator.clipboard?.writeText?.(text);
}

/** Bytes -> base64 (chunked: String.fromCharCode can't take millions of arguments). */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The clipboard's image as { mimeType, data (base64) }, or null if it holds none. */
export async function readClipboardImage() {
  if (isTauri) {
    const bytes = new Uint8Array(await invoke('clipboard_read_image'));
    return bytes.length ? { mimeType: 'image/png', data: toBase64(bytes) } : null;
  }
  for (const item of (await navigator.clipboard?.read?.()) ?? []) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return { mimeType: type, data: toBase64(new Uint8Array(await (await item.getType(type)).arrayBuffer())) };
  }
  return null;
}

/** An image File/Blob (e.g. from a paste event) as { mimeType, data }. */
export async function imageFromBlob(blob) {
  return { mimeType: blob.type || 'image/png', data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
}
