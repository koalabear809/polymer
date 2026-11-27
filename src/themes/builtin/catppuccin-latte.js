// Catppuccin Latte.

const p = {
  base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8', s0: '#ccd0da', s1: '#bcc0cc', s2: '#acb0be', o0: '#9ca0b0', o1: '#8c8fa1',
  o2: '#7c7f93', text: '#4c4f69', sub0: '#6c6f85', sub1: '#5c5f77', pink: '#ea76cb', mauve: '#8839ef', red: '#d20f39',
  maroon: '#e64553', peach: '#fe640b', yellow: '#df8e1d', green: '#40a02b', teal: '#179299', sky: '#04a5e5', sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd',
};

module.exports = {
  label: 'Catppuccin Latte',
  ui: {
    bg: p.base, bgAlt: p.mantle, bgHl: p.s0, bgSel: p.s1, fg: p.text, fgDim: p.o0, fgMuted: p.o2,
    accent: p.blue, accent2: p.mauve, match: p.peach, error: p.red, green: p.green, yellow: p.yellow, cyan: p.sky,
    border: p.crust, region: p.s1, regionLine: p.s0, search: p.s2,
  },
  syn: {
    comment: p.o1, keyword: p.mauve, preproc: p.pink, operator: p.sky, string: p.green, stringSpecial: p.pink,
    escape: p.pink, constant: p.peach, function: p.blue, builtin: p.red, macro: p.teal, type: p.yellow,
    parameter: p.maroon, property: p.lavender, attribute: p.yellow, tag: p.mauve, label: p.sapphire, punctuation: p.o2,
  },
  term: [p.sub1, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.s2, p.sub0, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.s1],
  colors: { '--color-scheme': 'light' },
};
