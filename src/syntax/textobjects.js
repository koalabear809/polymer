// Structural text objects and motions from the syntax tree (vim):
//   if / af   function body / whole function
//   ic / ac   class body / whole class (also structs, impls, interfaces, enums, traits)
//   ia / aa   argument or parameter / with its separator
//   ]f [f     next / previous function start
//   ]c [c     next / previous class start
//
// Node kinds are recognized by name, so they work across grammars without extra queries.
// Override the predicates (treesit-function-node-p, ...) with defun for a language that
// names things differently.

import { defun, call } from '../core/registry.js';
import { deftextobject, defmotion } from '../vim/core.js';
import { ensureTree, nodeAt } from './treesit.js';

const FUNCTION_RE = /(function|method|lambda|closure|func_literal|arrow_function)/;
const FUNCTION_EXCLUDE = /(call|type|parameter|signature|name|body|modifier|argument|item_list|specifier)/;
const CLASS_RE = /(class|struct|impl_item|interface|enum|trait|union)/;
const CLASS_EXCLUDE = /(body|name|heritage|identifier|_type$|field|list|member|specifier_qualifier|constant|variant|method)/;
const LIST_RE = /(arguments|parameters|argument_list|parameter_list|type_arguments|type_parameters)$/;

defun('treesit-function-node-p', (node) => FUNCTION_RE.test(node.type) && !FUNCTION_EXCLUDE.test(node.type), {
  doc: 'Whether a syntax node is a function/method/lambda (used by if/af and ]f/[f).',
});
defun('treesit-class-node-p', (node) => CLASS_RE.test(node.type) && !CLASS_EXCLUDE.test(node.type), {
  doc: 'Whether a syntax node is a class-like definition (used by ic/ac and ]c/[c).',
});
defun('treesit-argument-node-p', (node) => node.isNamed && !!node.parent && LIST_RE.test(node.parent.type) && node.type !== 'comment', {
  doc: 'Whether a syntax node is an argument or parameter (used by ia/aa).',
});

/** The count-th enclosing node at `pos` satisfying `pred` (by name). */
function enclosing(b, pos, predName, count = 1) {
  let found = null;
  let n = nodeAt(b, pos);
  let k = 0;
  for (; n; n = n.parent) {
    if (call(predName, n)) {
      found = n;
      if (++k >= count) break;
    }
  }
  return found;
}

/** Inner range of a definition: its body without braces (linewise if they sit on their own lines). */
function innerOf(b, node) {
  const body = node.childForFieldName('body') ?? node.namedChildren.at(-1);
  if (!body) return null;
  const text = b.getText(body.startIndex, body.endIndex);
  let from = body.startIndex;
  let to = body.endIndex;
  const open = text[0];
  const close = text.at(-1);
  if ((open === '{' && close === '}') || (open === '(' && close === ')') || (open === '[' && close === ']')) {
    from += 1;
    to -= 1;
    // Braces on their own lines: select the lines between them.
    const startLine = b.lineAt(body.startIndex);
    const endLine = b.lineAt(body.endIndex - 1);
    if (endLine - startLine >= 2 && b.lineEnd(startLine) === from && /^[ \t]*$/.test(b.getText(b.lineStart(endLine), to))) {
      return { from: b.lineStart(startLine + 1), to: b.lineEnd(endLine - 1), type: 'line' };
    }
    return { from, to, type: 'char' };
  }
  // Indentation-based bodies (Python): the body's lines.
  if (b.lineAt(from) !== b.lineAt(to)) return { from: b.lineStart(b.lineAt(from)), to: b.lineEnd(b.lineAt(to)), type: 'line' };
  return { from, to, type: 'char' };
}

/** Whole definition, linewise when it starts and ends its lines. */
function outerOf(b, node) {
  const sl = b.lineAt(node.startIndex);
  const el = b.lineAt(node.endIndex);
  const startsLine = /^[ \t]*$/.test(b.getText(b.lineStart(sl), node.startIndex));
  const endsLine = /^[ \t;,]*$/.test(b.getText(node.endIndex, b.lineEnd(el)));
  if (sl !== el && startsLine && endsLine) return { from: b.lineStart(sl), to: b.lineEnd(el), type: 'line' };
  return { from: node.startIndex, to: node.endIndex, type: 'char' };
}

function defObject(name, predName, inner) {
  deftextobject(name, { doc: `Tree-sitter text object (${predName}, ${inner ? 'inner' : 'outer'}).` }, (count, { buf, start }) => {
    if (!buf.treesit || !ensureTree(buf)) return null;
    const node = enclosing(buf, start, predName, count);
    if (!node) return null;
    return inner ? innerOf(buf, node) : outerOf(buf, node);
  });
}

defObject('vim-inner-function', 'treesit-function-node-p', true);
defObject('vim-a-function', 'treesit-function-node-p', false);
defObject('vim-inner-class', 'treesit-class-node-p', true);
defObject('vim-a-class', 'treesit-class-node-p', false);

function argumentObject(around) {
  return (count, { buf, start }) => {
    if (!buf.treesit || !ensureTree(buf)) return null;
    const node = enclosing(buf, start, 'treesit-argument-node-p', count);
    if (!node) return null;
    if (!around) return { from: node.startIndex, to: node.endIndex, type: 'char' };
    // Include the following separator and space, or the preceding one for the last item.
    const next = node.nextSibling;
    if (next && next.type === ',') {
      let to = next.endIndex;
      while (/[ \t]/.test(buf.text.charAt(to))) to++;
      return { from: node.startIndex, to, type: 'char' };
    }
    const prev = node.previousSibling;
    if (prev && prev.type === ',') return { from: prev.startIndex, to: node.endIndex, type: 'char' };
    return { from: node.startIndex, to: node.endIndex, type: 'char' };
  };
}

deftextobject('vim-inner-argument', { doc: 'An argument or parameter (ia).' }, argumentObject(false));
deftextobject('vim-a-argument', { doc: 'An argument or parameter with its separator (aa).' }, argumentObject(true));

// ---------------------------------------------------------------------------
// ]f [f ]c [c

/** Start offsets of all nodes satisfying a predicate, in document order. */
function starts(b, predName) {
  const tree = ensureTree(b);
  if (!tree) return [];
  const out = [];
  const cursor = tree.walk();
  const visit = () => {
    do {
      const n = cursor.currentNode;
      if (n.isNamed && call(predName, n)) out.push(n.startIndex);
      if (cursor.gotoFirstChild()) {
        visit();
        cursor.gotoParent();
      }
    } while (cursor.gotoNextSibling());
  };
  visit();
  cursor.delete();
  return out;
}

function defJump(name, predName, forward, what) {
  defmotion(name, { type: 'exclusive', jump: true, doc: `${forward ? 'Next' : 'Previous'} ${what} start.` }, (count, { buf, start }) => {
    if (!buf.treesit) return null;
    const list = starts(buf, predName);
    let pos = start;
    for (let i = 0; i < (count ?? 1); i++) {
      const p = forward ? list.find((s) => s > pos) : list.filter((s) => s < pos).at(-1);
      if (p === undefined) return i === 0 ? null : pos;
      pos = p;
    }
    return pos;
  });
}

defJump('vim-next-function-start', 'treesit-function-node-p', true, 'function');
defJump('vim-previous-function-start', 'treesit-function-node-p', false, 'function');
defJump('vim-next-class-start', 'treesit-class-node-p', true, 'class');
defJump('vim-previous-class-start', 'treesit-class-node-p', false, 'class');
