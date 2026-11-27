// The public API. Everything here is installed as a global (and on `polymer`), so
// init.js, packages and eval-expression can call it directly: defcommand(...), setq(...).

import * as registry from './registry.js';
import * as keymap from './keymap.js';
import * as keys from './keys.js';
import * as buffer from './buffer.js';
import * as modes from './modes.js';
import * as windows from './window.js';
import * as echo from './echo.js';
import * as printer from './printer.js';
import * as helm from './helm/helm.js';
import * as commandLoop from './command-loop.js';
import * as evaluation from './eval.js';
import * as host from './host.js';
import * as errors from './errors.js';
import * as loader from './loader.js';
import * as files from './files.js';
import * as vim from '../vim/core.js';
import * as treesit from '../syntax/treesit.js';
import * as terminal from '../terminal/term.js';
import * as themes from '../themes/themes.js';
import * as persp from '../persp/persp.js';
import * as git from '../git/git.js';
import * as agent from '../agent/agent.js';
import * as mcp from '../mcp/mcp.js';
import * as vimEx from '../vim/ex.js';
import * as vimRegisters from '../vim/registers.js';

export const api = {
  // registry
  defun: registry.defun,
  defcommand: registry.defcommand,
  call: registry.call,
  fboundp: registry.fboundp,
  commandp: registry.commandp,
  fmakunbound: registry.fmakunbound,
  functionInfo: registry.functionInfo,
  advice: registry.advice,
  removeAdvice: registry.removeAdvice,
  defvar: registry.defvar,
  setq: registry.setq,
  setDefault: registry.setDefault,
  setLocal: registry.setLocal,
  killLocal: registry.killLocal,
  getVar: registry.getVar,
  getVarOr: registry.getVarOr,
  boundp: registry.boundp,
  addVariableWatcher: registry.addVariableWatcher,
  removeVariableWatcher: registry.removeVariableWatcher,
  addHook: registry.addHook,
  removeHook: registry.removeHook,
  runHooks: registry.runHooks,
  runHooksAsync: registry.runHooksAsync,
  provide: registry.provide,
  featurep: registry.featurep,

  // keys
  defineKey: keymap.defineKey,
  keymap: keymap.keymap,
  lookupKey: keymap.lookupKey,
  whereIs: keymap.whereIs,
  parseKeys: keys.parseKeys,

  // command loop
  callInteractively: commandLoop.callInteractively,
  readKeySequence: commandLoop.readKeySequence,
  readChar: commandLoop.readChar,
  executeKeys: (keys) => commandLoop.executeKeys(typeof keys === 'string' ? commandLoop.parseKeyString(keys) : keys),
  thisCommandKeys: commandLoop.thisCommandKeysString,

  // buffers and modes
  currentBuffer: buffer.currentBuffer,
  getBuffer: buffer.getBuffer,
  getBufferCreate: buffer.getBufferCreate,
  generateNewBuffer: buffer.generateNewBuffer,
  bufferList: buffer.bufferList,
  withBuffer: buffer.withBuffer,
  renameBuffer: buffer.renameBuffer,
  defineMajorMode: modes.defineMajorMode,
  defineMinorMode: modes.defineMinorMode,
  setMajorMode: modes.setMajorMode,
  setMinorMode: modes.setMinorMode,
  derivedModeP: modes.derivedModeP,

  // windows
  selectedWindow: windows.selectedWindow,
  selectWindow: windows.selectWindow,
  windowList: windows.windowList,
  setWindowBuffer: windows.setWindowBuffer,
  displayBuffer: windows.displayBuffer,
  splitWindow: windows.splitWindow,
  deleteWindow: windows.deleteWindow,
  resizeWindow: windows.resizeWindow,

  // echo area
  message: echo.message,
  format: printer.format,
  prin1: printer.prin1,

  // completion
  helm: helm.helm,
  completingRead: helm.completingRead,
  readString: helm.readString,
  yesOrNo: helm.yesOrNo,
  helmSession: helm.helmSession,

  // loading and packages
  require: loader.require,
  load: loader.loadFile,
  usePackage: loader.usePackage,
  reloadPackage: loader.reloadPackage,
  packageDataDir: loader.packageDataDir,
  configDirectory: loader.configDirectory,

  // files
  expandFileName: files.expandFileName,
  abbreviateFileName: files.abbreviateFileName,
  readTextFile: files.readTextFile,
  writeTextFile: files.writeTextFile,
  listDirectory: files.listDirectory,
  makeDirectory: files.makeDirectory,
  fileExists: files.fileExists,
  findFileNoselect: files.findFileNoselect,

  // evaluation and host
  evalString: evaluation.evalString,
  invoke: host.invoke,
  isTauri: host.isTauri,

  // vim
  defmotion: vim.defmotion,
  defoperator: vim.defoperator,
  deftextobject: vim.deftextobject,
  defineExCommand: vimEx.defineExCommand,
  executeEx: vimEx.executeEx,
  getRegister: vimRegisters.getRegister,
  storeRegister: vimRegisters.storeRegister,

  // tree-sitter
  defineTreesitLanguage: treesit.defineTreesitLanguage,
  treesitTree: treesit.treesitTree,
  treesitNodeAt: treesit.nodeAt,
  treesitLanguageForBuffer: treesit.languageForBuffer,

  // themes
  defineTheme: themes.defineTheme,
  loadTheme: themes.loadTheme,
  getTheme: themes.getTheme,
  themeList: themes.themeList,
  currentTheme: themes.currentTheme,
  themeColor: themes.themeColor,
  themeColorsFrom: themes.themeColorsFrom,
  loadThemeFile: themes.loadThemeFile,
  loadThemes: themes.loadThemes,
  themeDirectory: themes.themeDirectory,
  installDefaultThemes: themes.installDefaultThemes,

  // perspectives
  perspSwitch: persp.perspSwitch,
  perspNames: persp.perspNames,
  currentPersp: persp.currentPersp,
  perspBufferList: persp.perspBufferList,
  defineBufferSerializer: persp.defineBufferSerializer,

  // git and processes
  runGit: git.runGit,
  gitRepoRoot: git.repoRoot,
  runProcess: (program, args = [], opts = {}) => host.invoke('run_process', { options: { program, args, ...opts } }),

  // agents
  defineAgent: agent.defineAgent,
  openAgent: agent.openAgent,
  agentSend: agent.agentSend,
  addAgentMcpProvider: agent.addAgentMcpProvider,

  // MCP
  defineMcpTool: mcp.defineMcpTool,
  mcpInfo: mcp.mcpInfo,

  // terminals
  openTerminal: terminal.openTerminal,

  // errors
  PolymerError: errors.PolymerError,
  Quit: errors.Quit,
};

/** Install the API as globals. Existing browser globals are never overwritten. */
export function installGlobals() {
  globalThis.polymer = api;
  for (const [name, value] of Object.entries(api)) {
    if (name in globalThis) {
      // Already defined, e.g. Tauri's read-only `isTauri`. Leave it alone either way.
      if (globalThis[name] !== value) console.warn(`polymer: not overwriting existing global "${name}"; use polymer.${name}`);
      continue;
    }
    try {
      globalThis[name] = value;
    } catch (e) {
      console.warn(`polymer: could not define global "${name}" (${e.message}); use polymer.${name}`);
    }
  }
}
