import type { FeatureModule, PageEvents } from '../types';
import type { SlotId, SlotItem } from '../../slots/types';
import { probeEditor } from './editor';
import { probeRecord } from './log';
import { ProbeIcon, ProbeMorePanel, ProbePanel, probeSlotItem } from './ProbeItems';

/** Every slot but the sidebar's, which gets two panels below. */
const TAGGED_SLOTS: readonly SlotId[] = [
  'toolbar.main', 'editor.status', 'editor.tools', 'editor.banners', 'pdf.status', 'pdf.actions', 'pdf.overlay',
  'files.footer', 'editor.overlay', 'home.toolbar', 'home.accountMenu', 'phone.moreSheet',
];

const EVENTS: readonly (keyof PageEvents)[] = [
  'docChanged', 'activeFile', 'filesChanged', 'filesMoved', 'compileRequested', 'compileFinished', 'agentWrite',
  'projectChanged', 'projectSettingsChanged', 'rosterChanged', 'commentsChanged', 'visibility', 'pdfSelection',
];

const slots: SlotItem[] = [
  // After every real item of the slot (the word count's `.pdf-status + .pdf-words` stays adjacent).
  ...TAGGED_SLOTS.map((slot): SlotItem => ({ id: `_probe.${slot}`, slot, order: 10_000, render: probeSlotItem(slot) })),
  { id: '_probe.panel', slot: 'sidebar.panels', order: 10_000, render: ProbePanel, panel: { title: 'Probe panel', icon: ProbeIcon, pinned: true } },
  { id: '_probe.morePanel', slot: 'sidebar.panels', order: 10_001, render: ProbeMorePanel, panel: { title: 'Probe more panel', icon: ProbeIcon } },
];

/**
 * The e2e probe (WP06): one contribution to every extension point, active
 * only when localStorage 'aldine.e2e.probe' is '1' (the page host leaves it
 * out otherwise). What each one does, and what the specs look for, is in
 * docs/galley-v2/WP06.md; every trigger is text or a name no real document
 * or project uses.
 */
const feature: FeatureModule = {
  id: '_probe',
  editor: probeEditor,
  commands: (page) => [{
    id: '_probe.hello',
    title: 'Probe: say hello',
    group: 'Probe',
    keywords: 'probe test',
    refusedFor: ['viewer', 'showcase'],
    keybinding: '_probe.hello',
    run: () => { probeRecord('command'); page.toast('Probe says hello', 'ok'); },
  }],
  // Unbound by default, so it can never collide with a real chord; specs record one in 'aldine.shortcuts'.
  keybindings: [{ id: '_probe.hello', label: 'Probe: say hello', group: 'Probe', default: null, changeable: true, scope: 'page', command: '_probe.hello' }],
  slots,
  contextMenu: [{
    id: '_probe.menu',
    group: 'annotate',
    order: 10_000,
    claims: (t) => t.view.state.doc.lineAt(t.pos).text === '%probe-menu',
    items: (t) => (t.view.state.doc.lineAt(t.pos).text === '%probe-menu'
      ? [{ id: '_probe.menu-item', label: 'Probe menu item', onSelect: () => probeRecord('menu'), testId: 'probe-menu-item' }]
      : null),
  }],
  pdfContextMenu: [{
    id: '_probe.pdfMenu',
    group: 'annotate',
    order: 10_000,
    items: (t) => (t.selection && /probe/i.test(t.selection.text)
      ? [{ id: '_probe.pdf-item', label: 'Probe PDF item', onSelect: () => probeRecord('pdfMenu'), testId: 'probe-pdf-item' }]
      : null),
  }],
  // No plugin is called '_probe': this exercises the merge, and shows nothing.
  pinnedPanels: [{ id: 'plugin:_probe', title: 'Probe plugin', icon: ProbeIcon, order: 10_000 }],
  readOnlyRules: [{ id: '_probe.readOnly', reason: (path) => (/(^|\/)probe-readonly\.tex$/.test(path) ? 'Probe: this file is read-only.' : null) }],
  interceptors: {
    async fileRename(r, page) {
      if (!r.to.endsWith('.probe-intercept')) return 'default';
      probeRecord(`intercept:fileRename:${r.via}`);
      page.toast(`Probe intercepted renaming ${r.from}`, 'info');
      return 'handled';
    },
    async projectRename(r) {
      if (r.to !== 'Probe intercept') return 'default';
      probeRecord('intercept:projectRename');
      return 'handled';
    },
  },
  activate(page) {
    const offs = EVENTS.map((name) => page.events.on(name, () => probeRecord(`event:${name}`)));
    document.documentElement.dataset.probeActive = `${page.projectId}::${page.branch}`;
    probeRecord('activate');
    return () => {
      offs.forEach((off) => off());
      if (document.documentElement.dataset.probeActive === `${page.projectId}::${page.branch}`) delete document.documentElement.dataset.probeActive;
      probeRecord('deactivate');
    };
  },
  boot() {
    document.documentElement.dataset.probeBoot = '1';
    probeRecord('boot');
  },
};

export default feature;
