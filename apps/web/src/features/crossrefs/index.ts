import type { FeatureModule } from '../types';
import { chord } from '../../keys/chords';
import { insertLabelHere, startRefPicker } from './actions';
import { labelCompletionSource } from './labelCompletion';
import { staleLabels } from './labelIndex';
import { closeRefPicker } from './store';
import RefPickerHost from './RefPickerHost';

const INSERT = 'crossrefs.insert';
const LABEL = 'crossrefs.label';
const isTex = (path: string | null) => !!path && /\.(tex|ltx)$/i.test(path);

/**
 * F17 cross-references (WP26). ⇧⌘X opens the cross-reference picker: the
 * project's labels grouped by kind with their captions and headings; Enter
 * writes the document's form (\cref with cleveref, \Cref under apa7, else
 * Figure~\ref, \eqref …), Tab references several (APA joining). "Insert label
 * here" (palette, context menu, bindable) writes a \label named from the
 * caption or heading, after the caption in a float. Typing \label{ offers
 * the same name as a completion (a switch in settings).
 */
const feature: FeatureModule = {
  id: 'crossrefs',
  // The source reads its switch (crossrefs.suggestLabel) on each query, so no reconfiguration is needed.
  editor: { completionSources: [labelCompletionSource] },
  commands: (page) => [
    {
      id: INSERT,
      title: 'Insert cross-reference…',
      group: 'Insert',
      keywords: 'cross-reference ref cref Cref label figure table equation section picker',
      keybinding: INSERT,
      refusedFor: ['viewer', 'showcase'],
      when: (p) => isTex(p.activeFile()),
      run: () => startRefPicker(page),
    },
    {
      id: LABEL,
      title: 'Insert label here',
      group: 'Insert',
      keywords: 'label name figure table section equation caption',
      keybinding: LABEL,
      refusedFor: ['viewer', 'showcase'],
      when: (p) => isTex(p.activeFile()),
      run: () => insertLabelHere(page),
    },
  ],
  keybindings: [
    { id: INSERT, label: 'Insert cross-reference', group: 'Citations', default: chord('mod+shift+x'), changeable: true, scope: 'page', command: INSERT },
    { id: LABEL, label: 'Insert label here', group: 'Citations', default: null, changeable: true, scope: 'editor', command: LABEL },
  ],
  slots: [{ id: 'crossrefs.picker', slot: 'editor.overlay', order: 410, render: RefPickerHost }],
  contextMenu: [{
    id: 'crossrefs.label',
    group: 'insert',
    order: 200,
    items: (t) => {
      const page = t.page;
      if (!page || !isTex(page.activeFile()) || !page.canEdit() || page.showcase()) return null;
      return [{ id: 'crossrefs-insert-label', label: 'Insert label here', onSelect: () => insertLabelHere(page), testId: 'crossrefs-menu-label' }];
    },
  }],
  activate(page) {
    const stale = () => staleLabels(page.projectId, page.branch);
    const offDoc = page.events.on('docChanged', stale);
    const offFiles = page.events.on('filesChanged', stale);
    const offActive = page.events.on('activeFile', () => closeRefPicker());
    return () => {
      offDoc();
      offFiles();
      offActive();
      closeRefPicker();
    };
  },
};

export default feature;
