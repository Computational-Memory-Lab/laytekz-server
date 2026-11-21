import type { EditorFeatureCtx, EditorPageCtx, FeatureModule } from '../types';
import type { CommandDef } from '../../commands/types';
import type { KeybindingDef } from '../../keys/types';
import type { TreeEntry } from '../../api';
import { api } from '../../api';
import { chord } from '../../keys/chords';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import { acceptGhost, acceptGhostWord, dismissGhost, ghostField } from './ghost';
import { askSuggestion, suggestExtension } from './scheduler';
import { createWordProvider } from './wordProvider';
import { suggestionProviders } from './provider';
import { SUGGEST_SETTINGS } from './settings';
import './model/register'; // Galley: V2 (WP43) the downloadable model registers itself as a provider; it loads nothing until switched on

const ASK = 'suggest.ask';

/** A switch is on unless the store says false (an unreadable store counts as on, like the auto-edit core). */
function on(read: () => unknown): boolean {
  try {
    return read() !== false;
  } catch {
    return true;
  }
}

const SOURCE_FILE = /\.(tex|ltx)$/i;
const MAX_FILES = 40;
const MAX_BYTES = 512 * 1024;
const fileTexts = new Map<string, { mtime: number | undefined; text: string }>();

/** The text of the project's other .tex files, each read again only once it changed. */
async function projectTexts(ctx: EditorFeatureCtx): Promise<string[]> {
  let entries: TreeEntry[] = [];
  try {
    entries = ctx.page()?.files() ?? [];
  } catch {
    return [];
  }
  const files = entries
    .filter((f) => f.type === 'file' && SOURCE_FILE.test(f.path) && f.path !== ctx.filePath && !(f.size && f.size > MAX_BYTES))
    .slice(0, MAX_FILES);
  const texts = await Promise.all(files.map(async (f) => {
    const key = `${ctx.projectId}::${ctx.branch}::${f.path}`;
    const have = fileTexts.get(key);
    if (have && f.mtime != null && have.mtime === f.mtime) return have.text;
    try {
      const text = await api.readFile(ctx.projectId, ctx.branch, f.path);
      fileTexts.set(key, { mtime: f.mtime, text });
      return text;
    } catch {
      return have?.text ?? '';
    }
  }));
  return texts.filter(Boolean);
}

function askNow(page: EditorPageCtx): void {
  const view = page.view();
  if (!view) return;
  if (view.state.field(ghostField, false) === undefined) {
    page.toast('Inline word suggestions are off.', 'info', {
      label: 'Open settings',
      run: () => page.openSettings({ section: 'completion', setting: SUGGEST_SETTINGS.words }),
    });
    return;
  }
  view.focus();
  view.dispatch({ effects: askSuggestion.of(null) });
}

const KEYBINDINGS: readonly KeybindingDef[] = [{
  id: ASK, label: 'Ask for a suggestion', group: 'Editor', default: chord('alt+\\', 'Backslash'),
  changeable: true, scope: 'editor', command: ASK, matchCode: true,
}];

/**
 * F12 inline suggestions (WP40): grey text after the caret completing a long
 * word from the project's own vocabulary, with no model. Tab accepts it
 * (after an open completion list and snippet fields), Mod-→ takes the next
 * word, Escape hides it, Alt+\ asks for one. Source mode only; switched by
 * Settings › Completion › Inline word suggestions. A model provider (WP43)
 * plugs in through provider.ts.
 */
const feature: FeatureModule = {
  id: 'suggest',
  editor: {
    modes: ['source'],
    deps: [SUGGEST_SETTINGS.words],
    extension(ctx) {
      if (!on(() => ctx.setting<boolean>(SUGGEST_SETTINGS.words))) return [];
      const words = createWordProvider({ projectTexts: () => projectTexts(ctx) });
      return suggestExtension({
        providers: () => [words, ...suggestionProviders()],
        synced: () => { try { return ctx.synced(); } catch { return true; } },
        nothing: () => ctx.notify('Nothing to suggest here.', 'info'),
      });
    },
    keyChains: [
      { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.suggestion, id: 'suggest.accept', run: acceptGhost },
      { key: 'Mod-ArrowRight', priority: KEY_CHAIN_PRIORITY['Mod-ArrowRight'].suggestionWord, id: 'suggest.acceptWord', run: acceptGhostWord },
      { key: 'Escape', priority: KEY_CHAIN_PRIORITY.Escape.suggestion, id: 'suggest.dismiss', run: dismissGhost },
    ],
  },
  keybindings: KEYBINDINGS,
  commands: (page): CommandDef[] => [{
    id: ASK,
    title: 'Ask for a word suggestion',
    group: 'Editor',
    keybinding: ASK,
    keywords: 'inline suggestion ghost complete word tab',
    refusedFor: ['showcase', 'viewer'],
    run: () => askNow(page),
  }],
};

export default feature;
