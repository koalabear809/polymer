// Tokyo Night (folke/tokyonight.nvim, "night" style).

module.exports = {
  label: 'Tokyo Night',
  ui: {
    bg: '#1a1b26', bgAlt: '#16161e', bgHl: '#292e42', bgSel: '#2f3549', fg: '#c0caf5', fgDim: '#565f89', fgMuted: '#737aa2',
    accent: '#7aa2f7', accent2: '#bb9af7', match: '#ff9e64', error: '#f7768e', green: '#9ece6a', yellow: '#e0af68', cyan: '#7dcfff',
    border: '#101014', region: '#364a82', regionLine: '#2a3456', search: '#3d59a1',
  },
  syn: {
    comment: '#565f89', keyword: '#bb9af7', preproc: '#7dcfff', operator: '#89ddff', string: '#9ece6a',
    stringSpecial: '#b4f9f8', escape: '#89ddff', constant: '#ff9e64', function: '#7aa2f7', builtin: '#2ac3de',
    macro: '#7dcfff', type: '#2ac3de', parameter: '#e0af68', property: '#73daca', attribute: '#bb9af7', tag: '#f7768e',
    label: '#7dcfff', punctuation: '#9aa5ce',
  },
  term: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#ff899d', '#9fe044', '#faba4a', '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5'],
};
