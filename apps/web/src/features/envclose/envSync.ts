/**
 * Linked `\begin`/`\end` names (WP31). An edit of the person's own inside the
 * name of a `\begin{…}` or `\end{…}` whose partner has the same name is
 * mirrored into the partner in the same transaction: one Yjs transaction,
 * one undo step. Only local `input.*` and `delete.*` transactions with one
 * change count; a collaborator's change, undo and redo carry no user event,
 * so they are never mirrored. While the caret is in a linked name, the
 * partner's name is outlined.
 */
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { envNameAt, envPartner, envScan, type EnvToken } from '../../editor/beginEnv';
import { envCloseConfig } from './config';

/** The mirrored change a transaction calls for, in the start document's positions, or null. */
export function mirroredChange(tr: Transaction): { from: number; to: number; insert: string } | null {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete')) || tr.isUserEvent('input.type.compose')) return null;
  const start = tr.startState;
  if (!start.facet(envCloseConfig).linked || start.readOnly) return null;
  const changes: { from: number; to: number; text: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { changes.push({ from: fromA, to: toA, text: inserted.toString() }); });
  if (changes.length !== 1) return null;
  const c = changes[0];
  if (/[{}\\%\s]/.test(c.text)) return null;
  const self = envNameAt(start, c.from, c.to);
  if (!self) return null;
  const partner = envPartner(start, self, envScan(start, self.from));
  if (!partner || partner.name !== self.name) return null;
  return { from: partner.nameFrom + (c.from - self.nameFrom), to: partner.nameFrom + (c.to - self.nameFrom), insert: c.text };
}

const envSyncFilter = EditorState.transactionFilter.of((tr) => {
  let m: ReturnType<typeof mirroredChange> = null;
  try {
    m = mirroredChange(tr);
  } catch (err) {
    console.warn('[envclose] linked rename skipped', err);
  }
  return m ? [tr, { changes: m, sequential: false }] : tr;
});

const partnerMark = Decoration.mark({ class: 'cm-envPartner', attributes: { 'data-testid': 'env-partner' } });

/** The partner name to outline for the caret, as a decoration set. */
export function partnerDecorations(state: EditorState): DecorationSet {
  const sel = state.selection;
  if (sel.ranges.length !== 1) return Decoration.none;
  const head = sel.main.head;
  const self: EnvToken | null = envNameAt(state, head);
  if (!self) return Decoration.none;
  const partner = envPartner(state, self, envScan(state, self.from));
  if (!partner || partner.name !== self.name || partner.nameTo <= partner.nameFrom) return Decoration.none;
  return Decoration.set([partnerMark.range(partner.nameFrom, partner.nameTo)]);
}

const partnerHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = partnerDecorations(view.state); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet) this.decorations = partnerDecorations(u.state);
  }
}, { decorations: (p) => p.decorations });

const partnerTheme = EditorView.baseTheme({
  '.cm-envPartner': {
    outline: '1px solid color-mix(in srgb, var(--accent, #3b82f6) 55%, transparent)',
    borderRadius: '2px',
  },
});

export const envSyncExtension: Extension = [envSyncFilter, partnerHighlight, partnerTheme];
