// One Dark (Atom).

const p = {
  bg: '#282c34', alt: '#21252b', hl: '#2c313a', sel: '#3e4451', fg: '#abb2bf', gray: '#5c6370',
  red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', purple: '#c678dd', cyan: '#56b6c2', orange: '#d19a66',
};

module.exports = {
  label: 'One Dark',
  ui: {
    bg: p.bg, bgAlt: p.alt, bgHl: p.hl, bgSel: p.sel, fg: p.fg, fgDim: '#4b5263', fgMuted: p.gray,
    accent: p.blue, accent2: p.purple, match: p.orange, error: p.red, green: p.green, yellow: p.yellow, cyan: p.cyan,
    border: '#181a1f', region: p.sel, regionLine: p.hl, search: '#4d5566',
  },
  syn: {
    comment: p.gray, keyword: p.purple, preproc: p.purple, operator: p.cyan, string: p.green, stringSpecial: p.cyan,
    escape: p.cyan, constant: p.orange, function: p.blue, builtin: p.cyan, macro: p.cyan, type: p.yellow,
    parameter: p.red, property: p.red, attribute: p.orange, tag: p.red, label: p.red, punctuation: p.fg,
  },
  term: ['#3f4451', p.red, p.green, p.yellow, p.blue, p.purple, p.cyan, '#d7dae0', '#4f5666', '#ff7b86', '#b1e18b', '#efb074', '#67cdff', '#e48bff', '#63d4e0', '#ffffff'],
};
