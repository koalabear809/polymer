// Gruvbox Dark (morhetz/gruvbox palette).
//
// A Polymer theme. The file name is the theme's name (M-x load-theme); files in
// ~/.polymer/themes/ replace the built-in ones. SPC h v custom-theme-directory lists the
// keys, and any CSS variable can also be set in `colors`.

const p = {
  bg0h: '#1d2021', bg0: '#282828', bg1: '#3c3836', bg2: '#504945', bg3: '#665c54', bg4: '#7c6f64',
  fg: '#ebdbb2', fg4: '#a89984', gray: '#928374',
  red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', purple: '#d3869b', aqua: '#8ec07c', orange: '#fe8019',
  red2: '#cc241d', green2: '#98971a', yellow2: '#d79921', blue2: '#458588', purple2: '#b16286', aqua2: '#689d6a',
};

module.exports = {
  label: 'Gruvbox Dark',
  ui: {
    bg: p.bg0, bgAlt: p.bg0h, bgHl: p.bg1, bgSel: p.bg2, fg: p.fg, fgDim: p.bg4, fgMuted: p.fg4,
    accent: p.blue, accent2: p.purple, match: p.orange, error: p.red, green: p.green, yellow: p.yellow, cyan: p.aqua,
    border: p.bg0h, region: p.bg2, regionLine: p.bg1, search: p.bg3,
  },
  syn: {
    comment: p.gray, keyword: p.red, preproc: p.aqua, operator: p.orange, string: p.green,
    stringSpecial: p.aqua, escape: p.orange, constant: p.purple, function: p.green, builtin: p.orange,
    macro: p.aqua, type: p.yellow, parameter: p.blue, property: p.blue, attribute: p.aqua, tag: p.red,
    label: p.yellow, punctuation: p.fg4,
  },
  term: [p.bg0, p.red2, p.green2, p.yellow2, p.blue2, p.purple2, p.aqua2, p.fg4, p.gray, p.red, p.green, p.yellow, p.blue, p.purple, p.aqua, p.fg],
};
