// Andromeda, after the VS Code theme by apoorvkhare07
// (marketplace: apoorvkhare07.andromeda-vscode; github.com/apoorvkhare07/andromeda).
// Near-black background, red variables, pale-yellow keywords, green strings.

const p = {
  bg: '#0a0a0a', panel: '#141414', line: '#1d1d1d', sel: '#333333', find: '#525252', bar: '#303030',
  white: '#ffffff', text: '#eeeeee', prop: '#e2e2e2', lineNr: '#808080', gray: '#848991', comment: '#777c85',
  red: '#f2777a', green: '#92d192', yellow: '#ffd479', keyword: '#ffeea6', blue: '#6ab0f3',
  magenta: '#e1a6f2', cyan: '#62cfcf', teal: '#76d4cd', orange: '#fca369', bronze: '#ac8d58',
};

module.exports = {
  label: 'Andromeda',
  ui: {
    bg: p.bg, bgAlt: p.panel, bgHl: p.line, bgSel: p.sel, fg: p.white, fgDim: p.lineNr, fgMuted: p.gray,
    accent: p.blue, accent2: p.magenta, match: p.orange, error: p.red, green: p.green, yellow: p.yellow, cyan: p.cyan,
    border: p.bar, region: p.sel, regionLine: p.line, search: p.find,
  },
  syn: {
    comment: p.comment, keyword: p.keyword, preproc: p.keyword, operator: p.bronze, string: p.green,
    stringSpecial: p.cyan, escape: p.bronze, constant: p.teal, function: p.white, builtin: p.teal,
    macro: p.teal, type: p.blue, parameter: p.red, property: p.prop, attribute: p.yellow, tag: p.blue,
    label: p.yellow, punctuation: p.text,
    // Optional keys: Andromeda gives variables and numbers their own colors.
    variable: p.red, number: p.orange,
  },
  term: [p.lineNr, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.white, '#777777', p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.white],
};
