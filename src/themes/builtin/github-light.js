// GitHub Light (GitHub's Primer colors).

const p = {
  bg: '#ffffff', subtle: '#f6f8fa', hl: '#eff2f5', sel: '#d6e6fb', border: '#d0d7de', fg: '#1f2328', muted: '#656d76', dim: '#8c959f',
  red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da', purple: '#8250df', cyan: '#1b7c83', orange: '#953800',
  navy: '#0a3069', constant: '#0550ae', comment: '#6e7781', success: '#1a7f37',
};

module.exports = {
  label: 'GitHub Light',
  ui: {
    bg: p.bg, bgAlt: p.subtle, bgHl: p.hl, bgSel: p.sel, fg: p.fg, fgDim: p.dim, fgMuted: p.muted,
    accent: p.blue, accent2: p.purple, match: p.orange, error: p.red, green: p.success, yellow: p.yellow, cyan: p.cyan,
    border: p.border, region: p.sel, regionLine: p.hl, search: '#fff8c5',
  },
  syn: {
    comment: p.comment, keyword: p.red, preproc: p.red, operator: p.red, string: p.navy, stringSpecial: p.constant,
    escape: p.constant, constant: p.constant, function: p.purple, builtin: p.constant, macro: p.purple, type: p.orange,
    parameter: p.orange, property: p.constant, attribute: p.constant, tag: p.green, label: p.purple, punctuation: p.fg,
  },
  term: ['#24292f', p.red, p.green, '#4d2d00', p.blue, p.purple, p.cyan, p.comment, '#57606a', '#a40e26', p.success, '#633c01', '#218bff', '#a475f9', '#3192aa', p.dim],
  colors: { '--color-scheme': 'light' },
};
