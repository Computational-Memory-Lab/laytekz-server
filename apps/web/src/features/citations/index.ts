import type { FeatureModule } from '../types';
import { chord } from '../../keys/chords';
import { setCiteCommandResolver } from '../../editor/core/hooks';
import { panelCommand, startPicker, toggleAtCaret } from './actions';
import { loadSetup, staleSetup } from './refIndex';
import { closePicker } from './store';
import PickerHost from './PickerHost';

const INSERT = 'citations.insert';
const TOGGLE = 'citations.toggle';
const isTex = (path: string | null) => !!path && /\.(tex|ltx)$/i.test(path);

/**
 * F17 citation shortcuts (WP19). ⇧⌘E opens the citation picker (search,
 * several keys, style, prenote and locator, edit mode with the caret in a
 * citation); ⇧⌘Space switches the citation at the caret between narrative
 * and parenthetical; the Cite and Zotero panels insert the document's
 * parenthetical command. Commands follow the document's package: biblatex,
 * natbib, apacite or plain BibTeX (WP15's GET …/cite-setup).
 */
const feature: FeatureModule = {
  id: 'citations',
  commands: (page) => [
    {
      id: INSERT,
      title: 'Insert citation…',
      group: 'Insert',
      keywords: 'cite citation reference bibliography parencite textcite citep citet picker',
      keybinding: INSERT,
      refusedFor: ['viewer', 'showcase'],
      when: (p) => isTex(p.activeFile()),
      run: () => startPicker(page),
    },
    {
      id: TOGGLE,
      title: 'Switch citation between narrative and parenthetical',
      group: 'Editor',
      keywords: 'cite citation narrative parenthetical in-text textcite parencite citet citep toggle',
      keybinding: TOGGLE,
      refusedFor: ['viewer', 'showcase'],
      when: (p) => isTex(p.activeFile()),
      run: () => toggleAtCaret(page),
    },
  ],
  keybindings: [
    { id: INSERT, label: 'Insert citation', group: 'Citations', default: chord('mod+shift+e'), changeable: true, scope: 'page', command: INSERT },
    { id: TOGGLE, label: 'Switch citation between narrative and parenthetical', group: 'Citations', default: chord('mod+shift+ '), changeable: true, scope: 'editor', command: TOGGLE },
  ],
  slots: [{ id: 'citations.picker', slot: 'editor.overlay', order: 400, render: PickerHost }],
  activate(page) {
    void loadSetup(page.projectId, page.branch);
    const offResolver = setCiteCommandResolver((state) => panelCommand(page.projectId, page.branch, state));
    // An edit may change the preamble: the next reader refetches.
    const offDoc = page.events.on('docChanged', () => staleSetup(page.projectId, page.branch));
    const offFiles = page.events.on('filesChanged', () => staleSetup(page.projectId, page.branch));
    const offActive = page.events.on('activeFile', () => { closePicker(); void loadSetup(page.projectId, page.branch); });
    return () => {
      offResolver();
      offDoc();
      offFiles();
      offActive();
      closePicker();
    };
  },
};

export default feature;
