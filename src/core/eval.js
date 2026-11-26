// Evaluating JavaScript at runtime.
//
// Code runs as the body of an async function in the global scope, so `await` works and
// all Polymer API globals (defcommand, setq, ...) are available. A single expression
// returns its value; statement code returns undefined unless it uses `return`.

const AsyncFunction = (async () => {}).constructor;
let counter = 0;

export function compile(code, filename) {
  const name = filename ?? `polymer-eval-${++counter}`;
  try {
    return new AsyncFunction(`return (\n${code}\n);\n//# sourceURL=${name}`);
  } catch {
    return new AsyncFunction(`${code}\n//# sourceURL=${name}`);
  }
}

/** Evaluate a string of JavaScript. Resolves with its value. */
export async function evalString(code, { filename } = {}) {
  return compile(code, filename)();
}
