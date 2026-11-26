// Access to the Rust side. Uses the global injected by Tauri (`withGlobalTauri`), so
// there is no npm dependency. In a plain browser (UI development) `isTauri` is false.

const T = globalThis.__TAURI__;

export const isTauri = !!T?.core;

export async function invoke(cmd, args) {
  if (!isTauri) throw new Error(`Not running under Tauri (invoke ${cmd})`);
  return T.core.invoke(cmd, args);
}

/** A Tauri channel for streaming messages from Rust: `onMessage` receives each one. */
export function createChannel(onMessage) {
  if (!isTauri) throw new Error('Not running under Tauri');
  const ch = new T.core.Channel();
  ch.onmessage = onMessage;
  return ch;
}

let info = null;
/** { version, platform, configDir } from the backend, or browser placeholders. */
export async function appInfo() {
  if (info) return info;
  info = isTauri
    ? await invoke('app_info')
    : { version: 'dev', platform: 'browser', configDir: null };
  return info;
}
