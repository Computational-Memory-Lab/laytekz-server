import { lazy } from 'react';
import { EditorView } from '@codemirror/view';
import type { CommandDef } from '../../commands/types';
import type { KeybindingDef } from '../../keys/types';
import type { ContextMenuEntry } from '../../contextmenu/types';
import type { SlotItem } from '../../slots/types';
import { chord } from '../../keys/chords';
import { chordLabel } from '../../keys/registry';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import type { EditorFeatureCtx, EditorPageCtx, FeatureModule } from '../types';
import { HIGHLIGHTS_KEY, PRESETS, colorName, readEntry } from './model';
import { clearHighlights, hlConfig, highlighterExtension, type Strength } from './extension';
import {
  currentColor, enabled, eraseSelection, highlightOrCard, paintSelection, say, selectionHasHighlight, setting, stepHighlight, watchView,
} from './actions';
import { cardField, closeCard } from './card';
import { contextItems } from './menuItems';
import { openColorDialog } from './dialog';
import { visualBars } from './visualBars';
import { IconHighlights } from './icons';

/**
 * F15 highlighter. WP32 built the data layer (the shared map, anchors, paint
 * semantics, the marks, undo); WP37 the interface: the split button
 * (`editor.tools` 300), the right-click entry, ⇧⌘H, the card, the
 * custom-colour dialog, the Highlights list, colour-blind patterns and the
 * bars beside block constructs in Visual mode.
 */
const DEPS = ['highlighter.enabled', 'highlighter.showOthers', 'highlighter.strength', 'highlighter.patterns'] as const;
const ME_KEY = 'aldine.highlighter.me';

/** This browser's author id when there are no accounts: "mine" means "made in this browser". */
function browserId(): string {
  try {
    const kept = localStorage.getItem(ME_KEY);
    if (kept && /^anon:[a-z0-9]{6,40}$/.test(kept)) return kept;
    const made = `anon:${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    localStorage.setItem(ME_KEY, made);
    return made;
  } catch { return 'anon:unsaved'; }
}

function configFrom(ctx: EditorFeatureCtx) {
  return {
    ydoc: ctx.ydoc,
    ytext: ctx.ytext,
    undoManager: ctx.undoManager,
    me: () => ({ id: ctx.identity.id ? `acct:${ctx.identity.id}` : browserId(), name: ctx.identity.name || '' }),
    showOthers: ctx.setting<boolean>('highlighter.showOthers') !== false,
    strength: ((s) => (s === 'light' || s === 'strong' ? s : 'medium'))(ctx.setting<Strength>('highlighter.strength')) as Strength,
    canWrite: () => !ctx.readOnly() && ctx.synced(),
    notify: ctx.notify,
  };
}

function withView(page: EditorPageCtx, fn: (view: EditorView) => void): void {
  const view = page.view();
  if (!view || !view.state.facet(hlConfig)) { say(page.toast, 'off'); return; }
  fn(view);
}

const undoToast = (page: EditorPageCtx, view: EditorView, n: number, none: string) => {
  const cfg = view.state.facet(hlConfig);
  page.toast(
    n ? `Cleared ${n} highlight${n === 1 ? '' : 's'}` : none,
    'info',
    n && cfg ? { label: 'Undo', run: () => { cfg.undoManager.undo(); } } : undefined,
  );
};

function clearAll(page: EditorPageCtx, view: EditorView): void {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return;
  const me = cfg.me().id;
  let all = 0;
  let mine = 0;
  cfg.ydoc.getMap<unknown>(HIGHLIGHTS_KEY).forEach((raw) => {
    const e = readEntry(raw);
    if (!e) return;
    all++;
    if (e.u === me) mine++;
  });
  if (!all) { page.toast('This file has no highlights.', 'info'); return; }
  const others = all - mine;
  void page.confirm({
    title: 'Clear all highlights in this file?',
    body: `This removes ${all} highlight${all === 1 ? '' : 's'}${others ? `, ${others} of them made by co-authors` : ''}. Undo brings them back.`,
    confirmLabel: 'Clear all',
    danger: true,
  }).then((ok) => { if (ok) undoToast(page, view, clearHighlights(view, 'all'), 'This file has no highlights.'); });
}

const KEYBINDINGS: readonly KeybindingDef[] = [{
  id: 'highlighter.highlight',
  label: 'Highlight the selection',
  group: 'Editor',
  default: chord('mod+shift+h'),
  changeable: true,
  scope: 'page-capture',
  command: 'highlighter.highlight',
}];

const WRITE: CommandDef['refusedFor'] = ['showcase', 'viewer'];
const KW = 'highlighter marker colour color';

const SLOTS: readonly SlotItem[] = [
  { id: 'highlighter.button', slot: 'editor.tools', order: 300, when: () => enabled(), render: lazy(() => import('./HighlightButton')) },
  {
    id: 'highlighter.list', slot: 'sidebar.panels', order: 300, when: () => enabled(),
    render: lazy(() => import('./HighlightsPanel')), panel: { title: 'Highlights', icon: IconHighlights, pinned: true },
  },
];

const CONTEXT_MENU: readonly ContextMenuEntry[] = [{
  id: 'highlighter.menu',
  group: 'annotate',
  order: 10,
  items: (t) => {
    if (!t.hadSelection || !enabled() || setting<boolean>('highlighter.contextMenu', true) === false) return null;
    const view = t.view;
    const cfg = view.state.facet(hlConfig);
    if (!cfg) return null;
    return contextItems(
      {
        current: currentColor(), custom: setting('highlighter.customColors', []), canWrite: cfg.canWrite(),
        hasSelection: !t.selection.empty || view.state.selection.ranges.some((r) => !r.empty),
        selectionHasHighlight: selectionHasHighlight(view.state), shortcut: chordLabel('highlighter.highlight'),
      },
      {
        pick: (c) => { paintSelection(view, c); },
        custom: () => openColorDialog({ onPick: (c) => { paintSelection(view, c); } }),
        erase: () => { eraseSelection(view); },
      },
    );
  },
}];

const feature: FeatureModule = {
  id: 'highlighter',
  editor: {
    files: /./,
    deps: DEPS,
    extension: (ctx) => {
      if (ctx.setting<boolean>('highlighter.enabled') === false) return [];
      return [
        highlighterExtension(configFrom(ctx)),
        cardField,
        watchView,
        ctx.setting<boolean>('highlighter.patterns') === true ? EditorView.editorAttributes.of({ 'data-hl-patterns': 'on' }) : [],
        ctx.mode() === 'visual' ? visualBars() : [],
      ];
    },
    keyChains: [{ key: 'Escape', priority: KEY_CHAIN_PRIORITY.Escape.highlightCard, id: 'highlighter.card', run: closeCard }],
  },
  keybindings: KEYBINDINGS,
  slots: SLOTS,
  contextMenu: CONTEXT_MENU,
  commands: (page): CommandDef[] => [
    {
      id: 'highlighter.highlight', title: 'Highlight the selection', group: 'Highlighter', keywords: KW,
      keybinding: 'highlighter.highlight', refusedFor: WRITE, when: enabled,
      run: () => withView(page, (view) => { highlightOrCard(view); }),
    },
    ...PRESETS.map((p): CommandDef => ({
      id: `highlighter.highlight.${p}`, title: `Highlight the selection ${colorName(p).toLowerCase()}`, group: 'Highlighter',
      keywords: KW, refusedFor: WRITE, when: enabled, run: () => withView(page, (view) => { paintSelection(view, p); }),
    })),
    {
      id: 'highlighter.custom', title: 'Highlight with a custom colour…', group: 'Highlighter', keywords: `${KW} hex custom`,
      refusedFor: WRITE, when: enabled,
      run: () => withView(page, (view) => openColorDialog({ onPick: (c) => { paintSelection(view, c); } })),
    },
    {
      id: 'highlighter.remove', title: 'Remove highlights from the selection', group: 'Highlighter', keywords: 'highlighter erase clear',
      refusedFor: WRITE, when: enabled, run: () => withView(page, (view) => { eraseSelection(view); }),
    },
    {
      id: 'highlighter.clearMine', title: 'Clear my highlights in this file', group: 'Highlighter', keywords: 'highlighter erase clear remove',
      refusedFor: WRITE, when: enabled,
      run: () => withView(page, (view) => undoToast(page, view, clearHighlights(view, 'mine'), 'You have no highlights in this file.')),
    },
    {
      id: 'highlighter.clearAll', title: 'Clear all highlights in this file…', group: 'Highlighter', keywords: 'highlighter erase clear remove',
      refusedFor: WRITE, when: enabled, run: () => withView(page, (view) => clearAll(page, view)),
    },
    {
      id: 'highlighter.next', title: 'Go to next highlight', group: 'Highlighter', keywords: KW, when: enabled,
      run: () => withView(page, (view) => { if (!stepHighlight(view, 1)) page.toast('This file has no highlights you can see.', 'info'); }),
    },
    {
      id: 'highlighter.prev', title: 'Go to previous highlight', group: 'Highlighter', keywords: KW, when: enabled,
      run: () => withView(page, (view) => { if (!stepHighlight(view, -1)) page.toast('This file has no highlights you can see.', 'info'); }),
    },
    {
      id: 'highlighter.list', title: 'Show highlights', group: 'Highlighter', keywords: `${KW} list panel`, when: enabled,
      run: () => page.ui.showPanel('highlighter.list'),
    },
    {
      id: 'highlighter.settings', title: 'Highlighter settings…', group: 'Highlighter', keywords: `${KW} settings preferences`,
      run: () => page.openSettings({ section: 'highlighter' }),
    },
  ],
};

export default feature;
