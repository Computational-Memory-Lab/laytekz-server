import { lazy } from 'react';
import { clearSnippet, nextSnippetField, prevSnippetField } from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import type { CommandDef } from '../../commands/types';
import type { KeybindingDef } from '../../keys/types';
import { chord } from '../../keys/chords';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import { ALIGN_MESSAGES, alignAllTablesCommand, alignTableCommand, runTableOp, tableOpProblem } from '../../editor/tables/commands';
import { keepAligned } from '../../editor/tables/keepAligned';
import { alignAfterFormat, tableAt } from '../../editor/tables/locate';
import { TABLE_OPS } from '../../editor/visual/tableEdit';
import type { EditorPageCtx, FeatureModule } from '../types';
import { peerCaretInside } from './actions';
import { TABLES_SETTING_IDS as ids } from './settings';
import { alignOptions, openTablePicker, setting } from './bus';

/**
 * F4 tables (WP18 on WP14's engine): the grid picker button in the editor
 * header, Align table columns on ⇧⌥A, the row and column operations in the
 * palette, Tab through a new table's fields, keep-aligned, and Format
 * document's realignment.
 */


const WRITE: CommandDef['refusedFor'] = ['showcase', 'viewer'];
const ALIGN = 'tables.align';

const KEYBINDINGS: readonly KeybindingDef[] = [{
  id: ALIGN, label: 'Align table columns', group: 'Editor', default: chord('alt+shift+a', 'KeyA'),
  changeable: true, scope: 'editor', command: ALIGN, matchCode: true,
}];

const isTex = (path: string | null) => !!path && /\.(tex|ltx)$/i.test(path);

function inTable(page: EditorPageCtx): boolean {
  const view = page.view();
  if (!view || !isTex(page.activeFile())) return false;
  try { return !!tableAt(view.state, view.state.selection.main.head); } catch { return false; }
}

function texView(page: EditorPageCtx) {
  const view = page.view();
  if (!view || !isTex(page.activeFile())) {
    page.toast('Open a .tex file in the code editor first.', 'info');
    return null;
  }
  if (view.state.readOnly) {
    page.toast('This file is read-only.', 'info');
    return null;
  }
  return view;
}

function alignCommands(page: EditorPageCtx): CommandDef[] {
  return [
    {
      id: ALIGN, title: 'Align table columns', group: 'Edit', keybinding: ALIGN, refusedFor: WRITE,
      keywords: 'table tabular align columns ampersand format pad texstudio',
      run: () => {
        const view = texView(page);
        if (!view) return;
        const outcome = alignTableCommand(view, alignOptions());
        if (outcome !== 'aligned') page.toast(ALIGN_MESSAGES[outcome], 'info');
      },
    },
    {
      id: 'tables.alignAll', title: 'Align all tables in this file', group: 'Edit', refusedFor: WRITE,
      keywords: 'table tabular align columns ampersand format pad every',
      run: () => {
        const view = texView(page);
        if (!view) return;
        const outcome = alignAllTablesCommand(view, alignOptions());
        if (outcome !== 'aligned') page.toast(ALIGN_MESSAGES[outcome], 'info');
      },
    },
  ];
}

/** "Table: insert row below" and the rest, shown while the cursor is in a table. */
function opCommands(page: EditorPageCtx): CommandDef[] {
  return TABLE_OPS.map((o): CommandDef => ({
    id: `tables.op.${o.op}`,
    title: o.group === 'align' ? `Table: align column ${o.label.toLowerCase()}` : `Table: ${o.label.charAt(0).toLowerCase()}${o.label.slice(1)}`,
    group: 'Table',
    keywords: 'table tabular row column cell',
    refusedFor: WRITE,
    when: () => inTable(page),
    run: () => {
      const view = texView(page);
      if (!view) return;
      const problem = tableOpProblem(view, o.op);
      if (problem) { page.toast(problem, 'info'); return; }
      runTableOp(view, o.op);
    },
  }));
}

const TableButton = lazy(() => import('./TableButton'));

const feature: FeatureModule = {
  id: 'tables',
  editor: {
    deps: [ids.keepAligned],
    extension(ctx) {
      if (ctx.setting<boolean>(ids.keepAligned) === false) return [];
      return keepAligned({
        options: () => (ctx.setting<boolean>(ids.keepAligned) === false ? null : alignOptions()),
        peerInside: (from, to) => peerCaretInside(ctx.awareness, ctx.ydoc, ctx.ytext, from, to),
      });
    },
    // a new table's cells, caption and label are snippet fields (actions.ts)
    keyChains: [
      { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.fields, id: 'tables.nextField', run: nextSnippetField },
      { key: 'Shift-Tab', priority: KEY_CHAIN_PRIORITY.Tab.fields, id: 'tables.prevField', run: prevSnippetField },
      { key: 'Escape', priority: KEY_CHAIN_PRIORITY.Escape.fields, id: 'tables.endFields', run: clearSnippet },
    ],
    afterFormat(state: EditorState) {
      if (setting<boolean>(ids.formatAligns, true) === false) return null;
      return alignAfterFormat(state, alignOptions());
    },
  },
  keybindings: KEYBINDINGS,
  commands: (page): CommandDef[] => [
    {
      id: 'tables.insert', title: 'Insert table…', group: 'Insert', refusedFor: WRITE,
      keywords: 'table tabular grid rows columns booktabs picker',
      run: () => { if (texView(page)) openTablePicker(page); },
    },
    ...alignCommands(page),
    ...opCommands(page),
  ],
  slots: [{
    id: 'tables.button',
    slot: 'editor.tools',
    order: 100,
    // the component hides itself when the setting is off, so the switch acts at once
    when: ({ page }) => !!page && isTex(page.activeFile()) && page.canEdit() && !page.showcase(),
    render: TableButton,
  }],
};

export default feature;
