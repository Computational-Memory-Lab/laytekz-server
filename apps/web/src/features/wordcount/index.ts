import type { FeatureModule, EditorPageCtx } from '../types';
import type { CommandDef } from '../../commands/types';
import type { SlotProps } from '../../slots/types';
import { previewKind } from '../../util/filePreview';
import { getSetting } from '../../settings/store';
import { applyExplicitEdit } from '../../editor/core/autoEdit';
import WordCountStatus from './Status';
import { liveCountExtension } from './live';
import { requestBreakdown } from './requests';
import { SHOW_SETTING, watchWordCount } from './store';

/** The count shows for every file that opens as text, as V1's did; a file outside the document gets its own count. */
const ANY_FILE = /[^]/;

/** The open file is text (an image, a PDF or another binary opens as a preview, with no count). */
function opensAsText(page: EditorPageCtx | null): boolean {
  const file = page?.activeFile();
  if (!page || !file) return false;
  return previewKind(file, page.files().find((e) => e.path === file)) === null;
}

const editorOnly = (page: EditorPageCtx | null) => {
  try { return page?.ui.layout() === 'editor'; } catch { return false; }
};

/**
 * Inserts a `%WC:<part>` marker line at the start of the caret's line, as one
 * undo step: everything from there on counts as that part, until the next marker.
 */
function insertMarker(page: EditorPageCtx, part: 'supplementary' | 'main' | 'excluded'): void {
  const view = page.view();
  if (!view) { page.toast('Open a file in the editor first.', 'error'); return; }
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const marker = `%WC:${part}`;
  const blank = line.text.trim() === '';
  const insert = blank ? marker : `${marker}\n`;
  applyExplicitEdit(view, {
    changes: { from: line.from, to: blank ? line.to : line.from, insert },
    selection: { anchor: line.from + marker.length + (blank ? 0 : 1) },
    scrollIntoView: true,
  }, 'input.wordcount');
  view.focus();
}

const isTex = (p: EditorPageCtx) => /\.(tex|ltx)$/i.test(p.activeFile() ?? '') && !!p.view();
const shown = () => getSetting<boolean>(SHOW_SETTING) !== false;

function commands(page: EditorPageCtx): CommandDef[] {
  return [
    {
      id: 'wordcount.breakdown',
      title: 'Show word count breakdown',
      group: 'Word count',
      keywords: 'words length target supplementary',
      when: (p) => shown() && opensAsText(p),
      run: () => { if (!requestBreakdown()) page.toast('The word count is not on screen.', 'info'); },
    },
    {
      id: 'wordcount.settings',
      title: 'Word count settings…',
      group: 'Word count',
      keywords: 'words rule target limit',
      run: () => page.openSettings({ section: 'wordcount' }),
    },
    {
      id: 'wordcount.markSupplementary',
      title: 'Count as supplementary from here',
      group: 'Word count',
      keywords: 'words marker %WC supplement',
      refusedFor: ['showcase', 'viewer'],
      when: isTex,
      run: () => insertMarker(page, 'supplementary'),
    },
    {
      id: 'wordcount.markMain',
      title: 'Count as main text from here',
      group: 'Word count',
      keywords: 'words marker %WC main',
      refusedFor: ['showcase', 'viewer'],
      when: isTex,
      run: () => insertMarker(page, 'main'),
    },
    {
      id: 'wordcount.markExcluded',
      title: 'Stop counting from here',
      group: 'Word count',
      keywords: 'words marker %WC not counted exclude ignore',
      refusedFor: ['showcase', 'viewer'],
      when: isTex,
      run: () => insertMarker(page, 'excluded'),
    },
  ];
}

/**
 * F13 word count (WP27): the rule-based count from the engine (WP24), live
 * while typing, in the PDF pane's header (the editor's in the Editor-only
 * layout), with a breakdown popover, the rule editor in settings, and the
 * `%WC:` marker commands.
 */
const feature: FeatureModule = {
  id: 'wordcount',
  editor: { files: ANY_FILE, extension: liveCountExtension },
  slots: [
    { id: 'wordcount.status', slot: 'pdf.status', order: 100, when: ({ page }: SlotProps) => opensAsText(page) && !editorOnly(page), render: WordCountStatus },
    { id: 'wordcount.statusEditor', slot: 'editor.status', order: 100, when: ({ page }: SlotProps) => opensAsText(page) && editorOnly(page), render: WordCountStatus },
  ],
  commands,
  activate: watchWordCount,
};

export default feature;
