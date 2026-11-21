/**
 * The probe's editor contributions. Each one acts only on text no document
 * contains by accident, so the probe never changes what a typist types:
 * - extension: `.cm-editor` gets `data-probe="on"`;
 * - key chain: Mod-ArrowRight on a line that is exactly `%probe-chain` appends ` ok`;
 * - mod-click: `\probelink` is a target; following it records 'modClick';
 * - automatic edit: typing `>` right after `%probe-` makes `%probe→`;
 * - completion: `\probec` offers `\probecompletion`;
 * - the completion filter and afterFormat run and change nothing.
 */
import { EditorView } from '@codemirror/view';
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { EditorContribution } from '../types';
import { probeRecord } from './log';

const LINK = '\\probelink';
const AUTO_TRIGGER = '%probe-';

const probeCompletions: CompletionSource = (cx: CompletionContext): CompletionResult | null => {
  const m = cx.matchBefore(/\\probec[a-z]*/);
  if (!m) return null;
  return { from: m.from, options: [{ label: '\\probecompletion', type: 'keyword', detail: 'probe' }] };
};

export const probeEditor: EditorContribution = {
  extension: () => EditorView.editorAttributes.of({ 'data-probe': 'on' }),
  keyChains: [{
    key: 'Mod-ArrowRight',
    priority: 10,
    id: '_probe.chain',
    run(view) {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      if (line.text !== '%probe-chain') return false;
      view.dispatch({ changes: { from: line.to, insert: ' ok' }, userEvent: 'input' });
      probeRecord('keyChain');
      return true;
    },
  }],
  modClick: [{
    id: '_probe.modClick',
    priority: 10,
    target(view, pos) {
      const line = view.state.doc.lineAt(pos);
      const at = line.text.indexOf(LINK);
      if (at < 0) return null;
      const from = line.from + at;
      const to = from + LINK.length;
      return pos >= from && pos <= to ? { from, to, title: 'Follow the probe link' } : null;
    },
    run() { probeRecord('modClick'); },
  }],
  autoEditRules: [{
    id: '_probe.arrow',
    priority: 1,
    settingId: '_probe.autoEdit',
    run(t) {
      if (t.char !== '>' || t.from < AUTO_TRIGGER.length) return null;
      if (t.before.sliceDoc(t.from - AUTO_TRIGGER.length, t.from) !== AUTO_TRIGGER) return null;
      return { rule: '_probe.arrow', changes: { from: t.from - 1, to: t.from + 1, insert: '→' }, selection: { anchor: t.from } };
    },
  }],
  completionSources: [() => probeCompletions],
  completionFilter: (r) => r,
  afterFormat: () => null,
};
