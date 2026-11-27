// Nord.

const p = {
  n0: '#2e3440', n1: '#3b4252', n2: '#434c5e', n3: '#4c566a', n4: '#d8dee9', n5: '#e5e9f0', n6: '#eceff4',
  n7: '#8fbcbb', n8: '#88c0d0', n9: '#81a1c1', n10: '#5e81ac',
  red: '#bf616a', orange: '#d08770', yellow: '#ebcb8b', green: '#a3be8c', purple: '#b48ead',
};

module.exports = {
  label: 'Nord',
  ui: {
    bg: p.n0, bgAlt: '#272c36', bgHl: p.n1, bgSel: p.n2, fg: p.n4, fgDim: p.n3, fgMuted: '#7b88a1',
    accent: p.n8, accent2: p.purple, match: p.orange, error: p.red, green: p.green, yellow: p.yellow, cyan: p.n7,
    border: '#242933', region: p.n2, regionLine: p.n1, search: p.n3,
  },
  syn: {
    comment: '#616e88', keyword: p.n9, preproc: p.n10, operator: p.n9, string: p.green, stringSpecial: p.yellow,
    escape: p.yellow, constant: p.purple, function: p.n8, builtin: p.n7, macro: p.n10, type: p.n7,
    parameter: p.n4, property: p.n4, attribute: p.n7, tag: p.n9, label: p.n7, punctuation: '#a0a8b7',
  },
  term: [p.n1, p.red, p.green, p.yellow, p.n9, p.purple, p.n8, p.n5, p.n3, p.red, p.green, p.yellow, p.n9, p.purple, p.n7, p.n6],
};
