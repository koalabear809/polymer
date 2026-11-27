// Gruvbox Light (morhetz/gruvbox palette).

const p = {
  bg0h: '#f9f5d7', bg0: '#fbf1c7', bg1: '#ebdbb2', bg2: '#d5c4a1', bg3: '#bdae93', bg4: '#a89984',
  fg: '#3c3836', fg4: '#7c6f64', gray: '#928374',
  red: '#9d0006', green: '#79740e', yellow: '#b57614', blue: '#076678', purple: '#8f3f71', aqua: '#427b58', orange: '#af3a03',
  red2: '#cc241d', green2: '#98971a', yellow2: '#d79921', blue2: '#458588', purple2: '#b16286', aqua2: '#689d6a',
};

module.exports = {
  label: 'Gruvbox Light',
  ui: {
    bg: p.bg0, bgAlt: p.bg0h, bgHl: p.bg1, bgSel: p.bg2, fg: p.fg, fgDim: p.bg4, fgMuted: p.fg4,
    accent: p.blue, accent2: p.purple, match: p.orange, error: p.red, green: p.green, yellow: p.yellow, cyan: p.aqua,
    border: p.bg1, region: p.bg2, regionLine: p.bg1, search: p.bg3,
  },
  syn: {
    comment: p.gray, keyword: p.red, preproc: p.aqua, operator: p.orange, string: p.green,
    stringSpecial: p.aqua, escape: p.orange, constant: p.purple, function: p.green, builtin: p.orange,
    macro: p.aqua, type: p.yellow, parameter: p.blue, property: p.blue, attribute: p.aqua, tag: p.red,
    label: p.yellow, punctuation: p.fg4,
  },
  term: [p.bg0, p.red2, p.green2, p.yellow2, p.blue2, p.purple2, p.aqua2, p.fg4, p.gray, p.red, p.green, p.yellow, p.blue, p.purple, p.aqua, p.fg],
  colors: { '--color-scheme': 'light' },
};
