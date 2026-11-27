// Solarized Light (Ethan Schoonover's palette).

const p = {
  base03: '#002b36', base02: '#073642', base01: '#586e75', base00: '#657b83',
  base0: '#839496', base1: '#93a1a1', base2: '#eee8d5', base3: '#fdf6e3',
  yellow: '#b58900', orange: '#cb4b16', red: '#dc322f', magenta: '#d33682',
  violet: '#6c71c4', blue: '#268bd2', cyan: '#2aa198', green: '#859900',
  sel: '#e4ddc8',
};

module.exports = {
  label: 'Solarized Light',
  ui: {
    bg: p.base3, bgAlt: p.base2, bgHl: p.base2, bgSel: p.sel, fg: p.base00, fgDim: p.base1, fgMuted: p.base0,
    accent: p.blue, accent2: p.violet, match: p.orange, error: p.red, green: p.green, yellow: p.yellow, cyan: p.cyan,
    border: p.sel, region: p.sel, regionLine: p.base2, search: '#d6cfb8',
  },
  syn: {
    comment: p.base1, keyword: p.green, preproc: p.orange, operator: p.base01, string: p.cyan,
    stringSpecial: p.red, escape: p.red, constant: p.cyan, function: p.blue, builtin: p.yellow,
    macro: p.orange, type: p.yellow, parameter: p.base01, property: p.blue, attribute: p.yellow, tag: p.blue,
    label: p.violet, punctuation: p.base01, number: p.magenta,
  },
  term: [p.base02, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.base2, p.base01, p.orange, p.green, p.yellow, p.blue, p.violet, p.cyan, p.base3],
  colors: { '--color-scheme': 'light' },
};
