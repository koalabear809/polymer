// Error types. `symbol` mirrors Emacs error symbols (void-function, quit, ...).

export class PolymerError extends Error {
  constructor(symbol, message, data) {
    super(message ?? symbol);
    this.name = 'PolymerError';
    this.symbol = symbol;
    this.data = data;
  }
}

/** Thrown when the user aborts (C-g, Esc out of a prompt). Callers usually let it propagate. */
export class Quit extends PolymerError {
  constructor() {
    super('quit', 'Quit');
    this.name = 'Quit';
  }
}

export const isQuit = (e) => e instanceof Quit;
