// Catppuccin Mocha.

const p = {
  base: '#1e1e2e', mantle: '#181825', crust: '#11111b', s0: '#313244', s1: '#45475a', s2: '#585b70', o0: '#6c7086', o1: '#7f849c',
  text: '#cdd6f4', sub0: '#a6adc8', sub1: '#bac2de', rosewater: '#f5e0dc', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8',
  maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe',
};

module.exports = {
  label: 'Catppuccin Mocha',
  ui: {
    bg: p.base, bgAlt: p.mantle, bgHl: p.s0, bgSel: p.s1, fg: p.text, fgDim: p.o0, fgMuted: p.o1,
    accent: p.blue, accent2: p.mauve, match: p.peach, error: p.red, green: p.green, yellow: p.yellow, cyan: p.sky,
    border: p.crust, region: p.s1, regionLine: p.s0, search: p.s2,
  },
  syn: {
    comment: p.o0, keyword: p.mauve, preproc: p.pink, operator: p.sky, string: p.green, stringSpecial: p.pink,
    escape: p.pink, constant: p.peach, function: p.blue, builtin: p.red, macro: p.teal, type: p.yellow,
    parameter: p.maroon, property: p.lavender, attribute: p.yellow, tag: p.mauve, label: p.sapphire, punctuation: p.o1,
  },
  term: [p.s1, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.sub1, p.s2, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.sub0],
};
