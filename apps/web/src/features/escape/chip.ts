/**
 * Feature 1 (WP10): the typing-context chip's state. A view plugin in the
 * open .tex file computes the context at the cursor (at most once a frame,
 * after a selection or document change or a parse step) and publishes a
 * label; ContextChip renders it in the `editor.status` slot.
 */
import type { Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { contextAt, type TexContext } from '../../editor/texContext';

export interface ChipInfo { label: string; tip: string; kind: TexContext['kind'] }

const BACKSPACE = 'Backspace right after an automatic change undoes it.';

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The chip's label and tooltip for a context; null when there is none (the tree is not ready). */
export function chipFor(cx: TexContext | null): ChipInfo | null {
  if (!cx) return null;
  const d = cx.detail;
  switch (cx.kind) {
    case 'text':
      return { kind: 'text', label: d === 'text in math' ? 'Text in math' : 'Text', tip: `Text: & becomes \\&, # becomes \\#, and % after a number becomes \\%. ${BACKSPACE}` };
    case 'table':
      return { kind: 'table', label: d ? `Table · ${d}` : 'Table', tip: `Table cell: & separates cells (type \\& for an ampersand), # becomes \\#, and % after a number becomes \\%. ${BACKSPACE}` };
    case 'math':
      return { kind: 'math', label: !d || d === 'inline' ? 'Math' : `Math · ${d}`, tip: `Math: & aligns columns, # becomes \\#, and % after a number becomes \\%. ${BACKSPACE}` };
    case 'comment':
      return { kind: 'comment', label: 'Comment', tip: 'Comment: what you type stays exactly as typed.' };
    case 'verbatim':
      return { kind: 'verbatim', label: 'Verbatim', tip: 'Verbatim: what you type stays exactly as typed.' };
    case 'literal':
      return { kind: 'literal', label: d ? `Literal · ${d}` : 'Literal', tip: 'Taken as written (a URL, path, key or label): what you type stays exactly as typed.' };
    case 'code':
      return {
        kind: 'code',
        label: d === 'preamble' ? 'Preamble' : d === 'definition' ? 'Definition' : d ? `Code · ${d}` : 'Code',
        tip: `${d === 'preamble' ? 'Preamble' : d === 'definition' ? 'Definition' : 'Code'}: what you type stays exactly as typed.`,
      };
    default:
      return { kind: cx.kind, label: cap(String(cx.kind)), tip: '' };
  }
}

// ---- The store the chip reads ----

let current: ChipInfo | null = null;
let owner: object | null = null;
const listeners = new Set<() => void>();

function publish(by: object, info: ChipInfo | null): void {
  if (info === null && owner !== by) return;
  owner = info === null ? null : by;
  if (current === info || (current && info && current.label === info.label && current.tip === info.tip)) return;
  current = info;
  for (const l of [...listeners]) l();
}

export function subscribeChip(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function chipSnapshot(): ChipInfo | null {
  return current;
}

const raf: (fn: () => void) => unknown = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
const caf: (h: unknown) => void = typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h as number) : (h) => clearTimeout(h as ReturnType<typeof setTimeout>);

class ChipPlugin {
  private frame: unknown = null;
  constructor(private view: EditorView) { this.schedule(); }

  update(u: ViewUpdate): void {
    if (u.docChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.schedule();
  }

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = raf(() => {
      this.frame = null;
      let info: ChipInfo | null = null;
      try {
        info = chipFor(contextAt(this.view.state, this.view.state.selection.main.head));
      } catch {
        info = null;
      }
      // The tree not ready yet: keep the last label; a later parse step updates it.
      if (info) publish(this, info);
    });
  }

  destroy(): void {
    if (this.frame !== null) caf(this.frame);
    this.frame = null;
    publish(this, null);
  }
}

export function chipExtension(): Extension {
  return ViewPlugin.define((view) => new ChipPlugin(view));
}
