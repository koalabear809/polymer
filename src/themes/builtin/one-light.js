// One Light (Atom).

const p = {
  bg: '#fafafa', alt: '#eaeaeb', hl: '#f0f0f1', sel: '#e5e5e6', fg: '#383a42', gray: '#a0a1a7', mono2: '#696c77',
  red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', purple: '#a626a4', cyan: '#0184bc', orange: '#986801',
};

module.exports = {
  label: 'One Light',
  ui: {
    bg: p.bg, bgAlt: p.alt, bgHl: p.hl, bgSel: p.sel, fg: p.fg, fgDim: '#9d9d9f', fgMuted: p.mono2,
    accent: p.blue, accent2: p.purple, match: p.orange, error: p.red, green: p.green, yellow: p.yellow, cyan: p.cyan,
    border: '#dbdbdc', region: p.sel, regionLine: p.hl, search: '#d4d4d6',
  },
  syn: {
    comment: p.gray, keyword: p.purple, preproc: p.purple, operator: p.cyan, string: p.green, stringSpecial: p.cyan,
    escape: p.cyan, constant: p.orange, function: p.blue, builtin: p.cyan, macro: p.cyan, type: p.yellow,
    parameter: p.red, property: p.red, attribute: p.orange, tag: p.red, label: p.red, punctuation: p.fg,
  },
  term: [p.fg, p.red, p.green, p.yellow, p.blue, p.purple, p.cyan, p.gray, p.mono2, '#ca1243', '#3e953d', p.orange, '#2f5fd0', '#8b1f8a', '#0170a0', p.alt],
  colors: { '--color-scheme': 'light' },
};
