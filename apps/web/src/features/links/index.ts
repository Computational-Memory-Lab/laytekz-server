import type { EditorPageCtx, FeatureModule } from '../types';
import type { MenuItemSpec } from '../../contextmenu/types';
import { chord } from '../../keys/chords';
import { followAtCaret } from '../../editor/core/modClick';
import { findReferences, keyAt, linkHandler, linksCtx, resolveAt, runAction, settingOn } from './follow';
import { copyAddress } from './open';
import { markStale } from './indexes';
import { LINKS_SETTINGS } from './settings';

const OPEN_AT_CURSOR = 'links.openAtCursor';
const FIND_REFERENCES = 'links.findReferences';

/** Text files: TeX sources and styles, .bib files (fields, keys), and notes (bare addresses). */
const FILES = /\.(tex|ltx|sty|cls|dtx|bib|bbx|cbx|md|markdown|txt)$/i;

function caretKey(page: EditorPageCtx): { key: string; view: NonNullable<ReturnType<EditorPageCtx['view']>> } | null {
  const view = page.view();
  const ctx = view?.state.facet(linksCtx);
  if (!view || !ctx) return null;
  const key = keyAt(view.state, view.state.selection.main.head, ctx.filePath);
  return key ? { key, view } : null;
}

/**
 * F18 links in the source (WP20), plus F17's go to definition and find
 * references. ⌘-click (Ctrl-click off a Mac) opens a web address, \url,
 * \href, a DOI, an arXiv id, an ORCID or a PubMed id in the browser through
 * the page's normal external-link path; in-project targets open the file
 * (\input, \includegraphics, \bibliography), go to a key's \label or .bib
 * entry, or find a \label's references. Alt+Enter follows at the caret,
 * Shift+Alt+Enter finds references, and a right-click on a link offers Open
 * and Copy. Each part has its own switch under Settings › Editor; nothing
 * here edits the document.
 */
const feature: FeatureModule = {
  id: 'links',
  editor: {
    files: FILES,
    extension: (ctx) => linksCtx.of(ctx),
    modClick: [linkHandler],
  },
  commands: (page) => [
    {
      id: OPEN_AT_CURSOR,
      title: 'Open the link at the cursor',
      group: 'Editor',
      keywords: 'follow link url href doi arxiv go to definition label citation file',
      keybinding: 'follow',
      when: (p) => !!p.view(),
      run: () => {
        const view = page.view();
        if (!view || !followAtCaret(view)) page.toast('No link, file, label or citation key at the cursor', 'info');
      },
    },
    {
      id: FIND_REFERENCES,
      title: 'Find references to the key at the cursor',
      group: 'Editor',
      keywords: 'find all references label ref cite citation key usages',
      keybinding: FIND_REFERENCES,
      when: (p) => !!p.view(),
      run: () => {
        const found = caretKey(page);
        const ctx = found?.view.state.facet(linksCtx);
        if (!found || !ctx) { page.toast('Put the cursor on a label, a reference or a citation key', 'info'); return; }
        findReferences(ctx, found.key);
      },
    },
  ],
  keybindings: [
    {
      id: FIND_REFERENCES, label: 'Find references to the key at the cursor', group: 'Editor',
      default: chord('alt+shift+Enter'), changeable: true, scope: 'editor', command: FIND_REFERENCES,
    },
  ],
  contextMenu: [{
    id: 'links.menu',
    group: 'link',
    order: 10,
    claims: (t) => {
      const ctx = t.view.state.facet(linksCtx);
      if (!ctx || !settingOn(ctx, LINKS_SETTINGS.menu)) return false;
      const r = resolveAt(t.view, t.pos);
      return !!r && !r.target.error;
    },
    items: (t) => {
      const ctx = t.view.state.facet(linksCtx);
      if (!ctx || !settingOn(ctx, LINKS_SETTINGS.menu)) return null;
      const r = resolveAt(t.view, t.pos);
      if (!r || r.target.error) return null;
      const a = r.action;
      const run = () => { void runAction(t.view, a); };
      const items: MenuItemSpec[] = [];
      if (a.kind === 'external') {
        items.push({ id: 'links-open', label: 'Open link', onSelect: run, testId: 'link-menu-open' });
        items.push({
          id: 'links-copy', label: 'Copy link address', testId: 'link-menu-copy',
          onSelect: () => { void copyAddress(a.href).then((ok) => { if (!ok) ctx.notify('The browser blocked copying the address', 'error'); }); },
        });
      } else if (a.kind === 'file') {
        items.push({ id: 'links-open-file', label: `Open ${a.path}`, onSelect: run, testId: 'link-menu-open-file' });
      } else if (a.kind === 'references') {
        items.push({ id: 'links-references', label: 'Find references', onSelect: run, testId: 'link-menu-references' });
      } else {
        items.push({ id: 'links-definition', label: 'Go to definition', onSelect: run, testId: 'link-menu-definition' });
        const key = r.hit.kind === 'ref' || r.hit.kind === 'cite' || r.hit.kind === 'bibkey' ? r.hit.key : null;
        if (key) items.push({ id: 'links-references', label: 'Find references', onSelect: () => findReferences(ctx, key), testId: 'link-menu-references' });
      }
      return items;
    },
  }],
  activate(page) {
    // Any edit or file change may add or move a label or an entry: the next look refetches.
    const stale = () => markStale(page.projectId, page.branch);
    const offs = [
      page.events.on('docChanged', stale),
      page.events.on('filesChanged', stale),
      page.events.on('filesMoved', stale),
      page.events.on('agentWrite', stale),
    ];
    return () => { for (const off of offs) off(); };
  },
};

export default feature;
