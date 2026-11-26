// Keyboard focus target for buffers (the hidden input element). Kept separate to avoid
// import cycles between windows and input handling.

let target = null;

export function setFocusTarget(el) { target = el; }

export function focusInput() {
  if (target && document.activeElement !== target) target.focus({ preventScroll: true });
}
