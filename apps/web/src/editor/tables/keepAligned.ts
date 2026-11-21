import { Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { applyExplicitEdit } from '../core/autoEdit';
import { alignTable, isAligned } from './align';
import type { AlignOptions } from './align';
import { tableAt } from './locate';
import { ALIGN_EVENT } from './commands';

/**
 * "Keep aligned tables aligned": once the person has typed in a table that
 * was aligned before their first edit in it, the table is realigned (lines
 * kept) when their caret leaves it, as an undo step of its own. A table
 * nobody aligned is never touched, so plain `a & b \\` tables stay as typed.
 *
 * Only the person's own typing and deleting count. A collaborator's edits
 * and Yjs undo and redo carry no userEvent, and the table commands, Format
 * document, Visual cell edits and automatic edits carry their own, so none
 * of them starts it. The realignment is skipped while a collaborator's
 * caret is inside the table (`peerInside`), and while the setting is off
 * (`options()` returns null).
 */

export interface KeepAlignedConfig {
  /** the aligner's options, or null while keep-aligned is turned off */
  options(): AlignOptions | null;
  /** whether a collaborator's focused caret is in `from`…`to` */
  peerInside?(from: number, to: number): boolean;
}

const OWN_EVENTS = /^(?:input|delete)(?:\.|$)/;
const OTHER_TOOLS = /^input\.(?:align|format|visual|table|auto|complete)(?:\.|$)/;

/** Whether `tr` is the person's own typing or deleting, which can start keep-aligned. */
export function marksTable(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  const ev = tr.annotation(Transaction.userEvent);
  return !!ev && OWN_EVENTS.test(ev) && !OTHER_TOOLS.test(ev);
}

export function keepAligned(cfg: KeepAlignedConfig): Extension {
  return ViewPlugin.fromClass(class {
    /** the aligned table being typed in, following every change */
    tracked: { from: number; to: number } | null = null;

    constructor(readonly view: EditorView) {}

    update(u: ViewUpdate) {
      const opts = cfg.options();
      if (!opts || u.state.readOnly) { this.tracked = null; return; }
      if (this.tracked && u.docChanged) {
        this.tracked = { from: u.changes.mapPos(this.tracked.from, 1), to: u.changes.mapPos(this.tracked.to, -1) };
      }
      if (u.docChanged && u.transactions.length === 1 && marksTable(u.transactions[0])) {
        let at = -1;
        u.changes.iterChangedRanges((fromA) => { if (at < 0) at = fromA; });
        const inTracked = this.tracked && u.changes.mapPos(at, 1) >= this.tracked.from && u.changes.mapPos(at, 1) <= this.tracked.to;
        if (!inTracked) {
          const before = tableAt(u.startState, at);
          if (before && isAligned(before.src, { ...opts, family: before.family })) {
            this.tracked = { from: u.changes.mapPos(before.from, 1), to: u.changes.mapPos(before.to, -1) };
          }
        }
      }
      const t = this.tracked;
      if (!t) return;
      const head = u.state.selection.main.head;
      if (head >= t.from && head <= t.to) return;
      this.tracked = null;
      const doc = u.state.doc;
      queueMicrotask(() => {
        const { view } = this;
        if (view.state.doc !== doc) return; // changed since: the edit would be stale
        const now = tableAt(view.state, t.from + 1);
        if (!now || now.from !== t.from) return;
        if (cfg.peerInside?.(now.from, now.to)) return;
        const changes = alignTable(now.src, { ...opts, family: now.family });
        if (!changes.length) return;
        applyExplicitEdit(view, { changes: changes.map((c) => ({ from: now.from + c.from, to: now.from + c.to, insert: c.insert })) }, ALIGN_EVENT);
      });
    }
  });
}
