/**
 * The highlighter's split button in the editor pane header (WP37,
 * `editor.tools` at 300): the main half highlights the selection with the
 * current colour (or removes it when the selection already shows that
 * colour, or opens the card of the highlight at the caret); the arrow opens
 * the colours and the other actions.
 */
import { useSyncExternalStore } from 'react';
import type { SlotProps } from '../../slots/types';
import { MenuButton } from '../../components/Menu';
import { IconChevronDown } from '../../components/Icons';
import { useSetting } from '../../settings/store';
import { useChordLabel } from '../../keys/registry';
import { colorName, drawnColor, isPreset, readEntry, HIGHLIGHTS_KEY } from './model';
import { isPainted } from './paint';
import { clearHighlights, hlConfig, selectionRanges } from './extension';
import { currentColor, eraseSelection, highlightOrCard, hlVersion, paintSelection, selectionHasHighlight, stepHighlight, visibleRuns } from './actions';
import { dropdownItems } from './menuItems';
import { openColorDialog } from './dialog';
import { IconHighlighter } from './icons';
import './ui.css';

/** The colour drawn in the button's bar: presets through their theme variable. */
const barColor = (c: string) => (isPreset(c) ? `var(--hl-swatch-${c})` : c);

export default function HighlightButton({ page }: SlotProps) {
  useSyncExternalStore(hlVersion.subscribe, hlVersion.get, hlVersion.get);
  const [on] = useSetting<boolean>('highlighter.enabled');
  useSetting<string>('highlighter.color');
  useSetting<boolean>('highlighter.rememberLast');
  const [custom] = useSetting<string[]>('highlighter.customColors');
  const chord = useChordLabel('highlighter.highlight');
  if (on === false || !page || !page.canEdit()) return null;
  const view = page.view();
  const cfg = view?.state.facet(hlConfig);
  if (!view || !cfg) return null;
  const canWrite = cfg.canWrite();
  const current = drawnColor(currentColor());
  const ranges = selectionRanges(view.state);
  const runs = visibleRuns(view.state);
  const pressed = ranges.length > 0 && isPainted(runs, ranges, current);
  const keys = chord ? ` (${chord})` : '';
  const title = !canWrite ? 'Highlighting is not available while the file loads or is read-only' : pressed ? `Remove highlight${keys}` : `Highlight ${colorName(current).toLowerCase()}${keys}`;

  const me = cfg.me().id;
  let all = 0;
  let mine = 0;
  cfg.ydoc.getMap<unknown>(HIGHLIGHTS_KEY).forEach((raw) => {
    const e = readEntry(raw);
    if (!e) return;
    all++;
    if (e.u === me) mine++;
  });

  const undoAction = { label: 'Undo', run: () => { cfg.undoManager.undo(); } };
  const items = () => dropdownItems(
    {
      current, custom, canWrite, hasSelection: ranges.length > 0, selectionHasHighlight: selectionHasHighlight(view.state),
      hasHighlights: runs.length > 0 || all > 0, hasMine: mine > 0,
    },
    {
      pick: (c) => paintSelection(view, c),
      custom: () => openColorDialog({ initial: isPreset(current) ? undefined : current, onPick: (c) => { paintSelection(view, c); } }),
      erase: () => { eraseSelection(view); },
      clearMine: () => {
        const n = clearHighlights(view, 'mine');
        page.toast(n ? `Cleared ${n} highlight${n === 1 ? '' : 's'}` : 'You have no highlights in this file.', 'info', n ? undoAction : undefined);
      },
      clearAll: () => {
        const others = all - mine;
        void page.confirm({
          title: 'Clear all highlights in this file?',
          body: `This removes ${all} highlight${all === 1 ? '' : 's'}${others ? `, ${others} of them made by co-authors` : ''}. Undo brings them back.`,
          confirmLabel: 'Clear all',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          const n = clearHighlights(view, 'all');
          page.toast(n ? `Cleared ${n} highlight${n === 1 ? '' : 's'}` : 'This file has no highlights.', 'info', n ? undoAction : undefined);
        });
      },
      step: (dir) => { if (!stepHighlight(view, dir)) page.toast('This file has no highlights you can see.', 'info'); },
      showList: () => page.ui.showPanel('highlighter.list'),
      settings: () => page.openSettings({ section: 'highlighter' }),
    },
  );

  return (
    <div className="split-btn hl-split" data-testid="highlight-split">
      <button
        type="button"
        className="btn btn--ghost btn--small split-btn__main hl-split__main"
        disabled={!canWrite}
        aria-pressed={pressed}
        title={title}
        aria-label={title}
        data-testid="highlight-button"
        data-hl-current={current}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { highlightOrCard(view); }}
      >
        <IconHighlighter bar={barColor(current)} />
      </button>
      <MenuButton
        className="btn btn--ghost btn--small split-btn__more hl-split__more"
        label="Highlighter"
        ariaLabel="Highlight colours and options"
        title="Highlight colours and options"
        testId="highlight-options"
        menuTestId="highlight-options-menu"
        placement="bottom-end"
        sheetTitle="Highlighter"
        items={items}
      >
        <IconChevronDown />
      </MenuButton>
    </div>
  );
}
