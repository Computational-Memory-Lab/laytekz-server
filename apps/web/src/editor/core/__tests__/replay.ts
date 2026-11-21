/**
 * Typing without a DOM (WP08 typing-core). `headlessView` runs what an
 * EditorView runs for typed text: input handlers, transactions, update
 * listeners (so autoEditCore's follow-ups happen as in the browser, from a
 * microtask), and the view plugins it is given (y-codemirror's binding and
 * undo manager, for collaboration tests). `replay` types a document
 * keystroke by keystroke and reports every keystroke after which the text
 * before the caret is not what was typed: the gate a typist who already
 * writes correct LaTeX must pass with every automation on.
 */
import { EditorSelection, EditorState, Transaction, type EditorStateConfig, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { deleteCharBackward, insertNewline } from '@codemirror/commands';
import { keyChains } from '../keyChains';
import type { ChainKey } from '../types';

export interface HeadlessView {
  state: EditorState;
  readonly composing: boolean;
  dispatch(...input: (TransactionSpec | Transaction)[]): void;
  /** Every transaction dispatched, oldest first. */
  readonly log: Transaction[];
  /** This object typed as an EditorView, for code that takes one (only state, dispatch and composing exist). */
  asView(): EditorView;
  destroy(): void;
}

/** ViewPlugin instances inside an extension tree (arrays and `{ extension }` wrappers). */
function viewPluginsIn(ext: Extension | undefined, out: ViewPlugin<PluginValue>[] = []): ViewPlugin<PluginValue>[] {
  if (!ext) return out;
  if (ext instanceof ViewPlugin) out.push(ext as ViewPlugin<PluginValue>);
  else if (Array.isArray(ext)) for (const e of ext) viewPluginsIn(e, out);
  else if (typeof ext === 'object' && 'extension' in ext) {
    // Facet providers, fields and compartment instances are their own `extension`.
    const inner = (ext as { extension: Extension }).extension;
    if (inner !== ext) viewPluginsIn(inner, out);
  }
  return out;
}

/**
 * A headless editor. `plugins` is an extension (usually also part of
 * `config.extensions`) whose ViewPlugins are instantiated and updated: only
 * plugins that never touch the DOM (ySync, yUndoManager) belong there.
 */
export function headlessView(config: EditorStateConfig, plugins?: Extension): HeadlessView {
  let updating = false;
  const instances: PluginValue[] = [];
  const view: HeadlessView = {
    state: EditorState.create(config),
    composing: false,
    log: [],
    asView: () => view as unknown as EditorView,
    dispatch(...input) {
      const tr = input.length === 1 && input[0] instanceof Transaction ? input[0] : view.state.update(...(input as TransactionSpec[]));
      if (updating) throw new Error('dispatch during an update (an EditorView would throw too)');
      updating = true;
      try {
        const startState = view.state;
        view.state = tr.state;
        view.log.push(tr);
        const update = {
          view: view.asView(), state: tr.state, startState, transactions: [tr], changes: tr.changes,
          docChanged: tr.docChanged, selectionSet: !!tr.selection, focusChanged: false, viewportChanged: false,
          viewportMoved: false, heightChanged: false, geometryChanged: false,
        } as unknown as ViewUpdate;
        for (const p of instances) p.update?.(update);
        for (const listener of tr.state.facet(EditorView.updateListener)) listener(update);
      } finally {
        updating = false;
      }
    },
    destroy() {
      for (const p of instances) p.destroy?.();
      instances.length = 0;
    },
  };
  for (const plugin of viewPluginsIn(plugins)) {
    // ViewPlugin.create is internal to @codemirror/view; a plugin that needs the DOM cannot run here anyway.
    instances.push((plugin as unknown as { create(v: EditorView, arg: unknown): PluginValue }).create(view.asView(), undefined));
  }
  return view;
}

/** Lets the microtasks queued by the last dispatch (autoEditCore's follow-up) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** Types one character as the browser would: input handlers first, then the plain insertion. */
export function typeChar(view: HeadlessView, ch: string): void {
  const { from, to } = view.state.selection.main;
  const plain = () => view.state.update(view.state.replaceSelection(ch), { userEvent: 'input.type', scrollIntoView: true });
  const handled = view.state.facet(EditorView.inputHandler).some((h) => h(view.asView(), from, to, ch, plain));
  if (!handled) view.dispatch(plain());
}

/** Types `text` one character (code point) at a time, letting follow-ups run after each. */
export async function typeText(view: HeadlessView, text: string): Promise<void> {
  for (const ch of text) {
    typeChar(view, ch);
    await settle();
  }
}

/** A key the key chains handle: their entries by priority, then the default command (Backspace, Enter). */
export async function pressKey(view: HeadlessView, key: ChainKey): Promise<boolean> {
  const entries = view.state.facet(keyChains).filter((e) => e.key === key).sort((a, b) => b.priority - a.priority);
  let handled = entries.some((e) => e.run(view.asView()));
  if (!handled && key === 'Backspace') handled = deleteCharBackward(view.asView());
  if (!handled && key === 'Enter') handled = insertNewline(view.asView());
  await settle();
  return handled;
}

/** The document as `text` with `|` at the caret. */
export function withCaret(view: HeadlessView): string {
  const head = view.state.selection.main.head;
  const doc = view.state.doc.toString();
  return `${doc.slice(0, head)}|${doc.slice(head)}`;
}

export interface Divergence {
  /** 0-based index of the keystroke after which the text before the caret differed. */
  keystroke: number;
  /** The last 40 characters typed, and what the editor holds there instead. */
  typed: string;
  got: string;
}

export interface ReplayResult {
  keystrokes: number;
  /** Automatic edits dispatched (userEvent input.auto). */
  autoEdits: number;
  divergences: Divergence[];
  /** The final document, and whether it equals the source (closers left after the caret make it differ). */
  doc: string;
  identical: boolean;
}

/**
 * Types `source` into an empty editor keystroke by keystroke, newlines
 * included as typed characters (no auto-indent), and compares the text
 * before the caret with what was typed after each one. After a divergence
 * the comparison continues from what the editor holds, so each is counted
 * once.
 */
export async function replay(source: string, extensions: Extension, plugins?: Extension): Promise<ReplayResult> {
  const view = headlessView({ doc: '', selection: EditorSelection.cursor(0), extensions }, plugins);
  const divergences: Divergence[] = [];
  let typed = '';
  let keystrokes = 0;
  for (const ch of source) {
    const start = view.log.length;
    typeChar(view, ch);
    await settle();
    typed += ch;
    // The text before the caret can only differ after something other than the keystroke's own insertion.
    const steps = view.log.slice(start);
    if (steps.length !== 1 || !plainKeystroke(steps[0], ch)) {
      const before = view.state.sliceDoc(0, view.state.selection.main.head);
      if (before !== typed) {
        divergences.push({ keystroke: keystrokes, typed: typed.slice(-40), got: before.slice(-40) });
        typed = before;
      }
    }
    keystrokes++;
  }
  const doc = view.state.doc.toString();
  const autoEdits = view.log.filter((tr) => tr.isUserEvent('input.auto')).length;
  view.destroy();
  return { keystrokes, autoEdits, divergences, doc, identical: doc === source };
}

/** Whether `tr` only put `ch` before the caret: inserted at it (closers after it allowed) or stepped over it. */
function plainKeystroke(tr: Transaction, ch: string): boolean {
  const before = tr.startState.selection.main;
  const after = tr.state.selection.main;
  if (!tr.isUserEvent('input.type') || !before.empty || !after.empty || after.head !== before.head + ch.length) return false;
  if (!tr.docChanged) return tr.startState.sliceDoc(before.head, after.head) === ch;
  let changes = 0;
  let atCaret = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes++;
    if (fromA !== before.head || toA !== fromA || !inserted.sliceString(0, ch.length).startsWith(ch)) atCaret = false;
  });
  return changes === 1 && atCaret;
}
