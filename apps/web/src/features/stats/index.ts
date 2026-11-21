import { lazy } from 'react';
import type { EditorView } from '@codemirror/view';
import type { CommandDef } from '../../commands/types';
import { chord } from '../../keys/chords';
import type { KeybindingDef } from '../../keys/types';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import { setMacroContext } from '../../editor/visual/context';
import type { EditorFeatureCtx, EditorPageCtx, FeatureModule } from '../types';
import { autoMathFormatters } from '../automath/api';
import { resolveStyle } from './core/style';
import { reformatStatistics } from './core/parse';
import { greekFor, statsConfig, type StatsConfig } from './config';
import { escapeFields, fieldsExtension, finishField, nextField, sessionField } from './fields';
import { convertRange, expandTrigger, paragraphAt, statsCompletionSource } from './insert';
import { pasteExtension } from './paste';
import { typedStatisticFormatter } from './typed';
import { clearOffer, closePicker, openPicker } from './ui';
import { STATS_SETTING_IDS } from './settings';
import { statsEdit } from '../../editor/core/autoEdit';
import { closeUndoStep } from '../../editor/visual/history';

/**
 * F16 statistics in the editor (WP38; core: WP33). Triggers such as `\pval`
 * in the completion list (or Tab after one), fields that format each number
 * when it is left, the picker on ⇧⌘U, the paste offer for R and Python
 * output, "Convert to APA statistics" and "Reformat statistics in this file",
 * and the house style for typed statistics through automatic math mode.
 */

const DEPS = [
  STATS_SETTING_IDS.style, STATS_SETTING_IDS.triggers, STATS_SETTING_IDS.formatOnLeave,
  STATS_SETTING_IDS.typed, STATS_SETTING_IDS.pasteOffer,
] as const;

function configFrom(ctx: EditorFeatureCtx): StatsConfig {
  const on = (id: string) => ctx.setting<boolean>(id) !== false;
  return {
    style: resolveStyle(ctx.projectSetting<unknown>(STATS_SETTING_IDS.style)),
    triggers: on(STATS_SETTING_IDS.triggers),
    formatOnLeave: on(STATS_SETTING_IDS.formatOnLeave),
    typed: on(STATS_SETTING_IDS.typed),
    paste: on(STATS_SETTING_IDS.pasteOffer),
  };
}

const TEX = /\.(tex|ltx)$/i;
const WRITE: CommandDef['refusedFor'] = ['showcase', 'viewer'];

function texView(page: EditorPageCtx): EditorView | null {
  const view = page.view();
  const file = page.activeFile();
  // The feature runs in this editor only when its session field is installed.
  if (!view || !file || !TEX.test(file) || view.state.field(sessionField, false) === undefined) return null;
  return view;
}

function withView(page: EditorPageCtx, fn: (view: EditorView) => void): void {
  const view = texView(page);
  if (!view) { page.toast('Open a .tex file in the code editor first.', 'info'); return; }
  if (view.state.readOnly) { page.toast('This file is read-only.', 'info'); return; }
  fn(view);
}

const plural = (n: number) => `${n} statistic${n === 1 ? '' : 's'}`;

const KEYBINDINGS: readonly KeybindingDef[] = [{
  id: 'stats.insert',
  label: 'Insert statistic',
  group: 'Statistics',
  default: chord('mod+shift+u'),
  changeable: true,
  scope: 'page',
  command: 'stats.insert',
}];

const feature: FeatureModule = {
  id: 'stats',
  editor: {
    deps: DEPS,
    extension: (ctx) => {
      try { setMacroContext(ctx.projectId, ctx.branch, ctx.rootFile); } catch { /* the trigger hiding then reads this file only */ }
      return [
        statsConfig.of(configFrom(ctx)),
        fieldsExtension(),
        pasteExtension(),
        autoMathFormatters.of(typedStatisticFormatter),
      ];
    },
    completionSources: [() => statsCompletionSource],
    keyChains: [
      { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.fields, id: 'stats.fields.next', run: (v) => nextField(v, 1) },
      { key: 'Shift-Tab', priority: KEY_CHAIN_PRIORITY.Tab.fields, id: 'stats.fields.previous', run: (v) => nextField(v, -1) },
      { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.statTrigger, id: 'stats.trigger', run: expandTrigger },
      { key: 'Enter', priority: KEY_CHAIN_PRIORITY.Enter.statFinish, id: 'stats.fields.finish', run: finishField },
      { key: 'Escape', priority: KEY_CHAIN_PRIORITY.Escape.fields, id: 'stats.fields.stop', run: escapeFields },
    ],
  },
  keybindings: KEYBINDINGS,
  // The picker and the paste offer belong to the page they opened on.
  activate: () => () => { closePicker(); clearOffer(); },
  commands: (page): CommandDef[] => [
    {
      id: 'stats.insert', title: 'Insert statistic…', group: 'Insert', keybinding: 'stats.insert',
      keywords: 'statistics p value t test anova bayes factor effect size apa', refusedFor: WRITE,
      run: () => { if (texView(page)) openPicker(); else page.toast('Open a .tex file in the code editor to insert a statistic.', 'info'); },
    },
    {
      id: 'stats.convert', title: 'Convert to APA statistics', group: 'Insert',
      keywords: 'statistics convert r python output apa format selection paragraph', refusedFor: WRITE,
      run: () => withView(page, (view) => {
        const sel = view.state.selection.main;
        const range = sel.empty ? paragraphAt(view.state, sel.head) : { from: sel.from, to: sel.to };
        const n = convertRange(view, range);
        page.toast(n ? `Converted ${plural(n)}. Undo brings back the text.` : `No statistics found in the ${sel.empty ? 'paragraph' : 'selection'}.`, n ? 'ok' : 'info');
      }),
    },
    {
      id: 'stats.reformat', title: 'Reformat statistics in this file', group: 'Insert',
      keywords: 'statistics house style apa reformat leading zero decimals', refusedFor: WRITE,
      run: () => withView(page, (view) => {
        const cfg = view.state.facet(statsConfig);
        const r = reformatStatistics(view.state.doc.toString(), { style: cfg.style, greek: greekFor(view.state, cfg.style) });
        if (!r.count) { page.toast('Every statistic in this file already follows the house style.', 'info'); return; }
        closeUndoStep(view.state);
        view.dispatch({ changes: r.changes, annotations: statsEdit.of(true), userEvent: 'input.stats' });
        closeUndoStep(view.state);
        page.toast(`Reformatted ${plural(r.count)}. Undo brings back the old text.`, 'ok');
      }),
    },
    {
      id: 'stats.settings', title: 'Statistics settings', group: 'Settings', keywords: 'statistics house style apa',
      run: () => page.openSettings({ section: 'statistics' }),
    },
  ],
  slots: [
    { id: 'stats.overlay', slot: 'editor.overlay', order: 200, render: lazy(() => import('./StatsOverlay')) },
    {
      id: 'stats.tools', slot: 'editor.tools', order: 200, render: lazy(() => import('./ToolsButton')),
      when: ({ page }) => !!page && page.canEdit() && !page.showcase() && TEX.test(page.activeFile() ?? ''),
    },
  ],
};

export default feature;
