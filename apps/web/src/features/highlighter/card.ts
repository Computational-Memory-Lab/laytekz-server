/**
 * The highlight card (WP37): a plain click that leaves the caret inside a
 * highlight shows who made it and when, the colours, "Select text" and
 * "Remove". It closes on typing, Escape, or the caret moving out; arrow-key
 * moves never open it. A review comment at the same spot wins (its own card).
 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import { commentRangesField } from '../../editor/visual/suggestions';
import { PRESETS, colorName, drawnColor, isPreset, type Run } from './model';
import { applyHighlight, hlConfig, highlightRuns } from './extension';
import { ago, chooseColor, runAt, setting } from './query';
import { cleanCustomList } from './colors';
import { openColorDialog } from './dialog';

const setCard = StateEffect.define<{ key: string; focus: boolean } | null>();

interface CardValue { key: string; focus: boolean }

function runByKey(state: EditorState, key: string): Run | null {
  return highlightRuns(state).find((r) => r.key === key) ?? null;
}

function inComment(state: EditorState, pos: number): boolean {
  const ranges = state.field(commentRangesField, false);
  return !!ranges?.some((r) => !r.resolved && r.from <= pos && pos <= r.to);
}

export const cardField = StateField.define<CardValue | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCard)) return e.value && runByKey(tr.state, e.value.key) ? e.value : null;
    }
    if (value) {
      if (tr.docChanged) return null;
      const run = runByKey(tr.state, value.key);
      if (!run) return null;
      const sel = tr.state.selection.main;
      if (tr.selection && (sel.head < run.from || sel.head > run.to)) return null;
    }
    if (tr.selection && tr.isUserEvent('select.pointer') && tr.state.selection.main.empty && tr.state.facet(hlConfig)
      && setting<boolean>('highlighter.card', true) !== false) {
      const head = tr.state.selection.main.head;
      const run = runAt(tr.state, head);
      if (run && head > run.from && head < run.to && !inComment(tr.state, head)) return { key: run.key, focus: false };
      if (!run) return null;
    }
    return value;
  },
  provide: (f) => showTooltip.computeN([f], (state) => {
    const v = state.field(f);
    if (!v) return [];
    const run = runByKey(state, v.key);
    if (!run) return [];
    return [tooltipFor(run, v.focus)];
  }),
});

/** Opens the card of the highlight `key` (keyboard: focus goes to its colours). */
export function openCard(view: EditorView, key: string, focus = true): void {
  view.dispatch({ effects: setCard.of({ key, focus }) });
}

export function closeCard(view: EditorView): boolean {
  if (!view.state.field(cardField, false)) return false;
  view.dispatch({ effects: setCard.of(null) });
  return true;
}

function button(label: string, testId: string, onClick: () => void, cls = 'hl-card__btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.setAttribute('data-testid', testId);
  // Keep the editor's selection: a press in the card must not move the caret.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return b;
}

function swatch(color: string, current: boolean, onPick: () => void): HTMLButtonElement {
  const name = colorName(color);
  const b = button('', `highlight-card-swatch-${isPreset(color) ? color : color.slice(1)}`, onPick, 'hl-swatch-btn');
  b.title = name;
  b.setAttribute('aria-label', name);
  b.setAttribute('aria-pressed', String(current));
  const dot = document.createElement('span');
  dot.className = `hl-swatch hl-swatch--${isPreset(color) ? color : 'custom'}`;
  if (!isPreset(color)) dot.style.setProperty('--hl', color);
  b.appendChild(dot);
  return b;
}

function tooltipFor(run: Run, focus: boolean): Tooltip {
  return {
    pos: run.from,
    end: run.to,
    above: true,
    create(view) {
      const dom = document.createElement('div');
      dom.className = 'hl-card';
      dom.setAttribute('data-testid', 'highlight-card');
      dom.setAttribute('role', 'dialog');
      const shown = drawnColor(run.color);
      dom.setAttribute('aria-label', `${colorName(shown)} highlight`);
      const title = document.createElement('div');
      title.className = 'hl-card__title';
      title.setAttribute('data-testid', 'highlight-card-title');
      title.textContent = [`${colorName(shown)} highlight`, run.name || null, ago(run.t)].filter(Boolean).join(' · ');
      dom.appendChild(title);
      const cfg = view.state.facet(hlConfig);
      const live = () => runByKey(view.state, run.key) ?? run;
      const paintWith = (c: string) => {
        const now = live();
        const me = cfg?.me();
        if (!me) return;
        const r = applyHighlight(view, [{ from: now.from, to: now.to }], { kind: 'paint', color: c, author: me.id, name: me.name, t: Date.now() });
        if (r === 'done') chooseColor(c);
        closeCard(view);
      };
      if (cfg?.canWrite()) {
        const row = document.createElement('div');
        row.className = 'hl-card__swatches';
        const custom = cleanCustomList(setting('highlighter.customColors', []));
        for (const c of [...PRESETS, ...custom]) row.appendChild(swatch(c, c === shown, () => paintWith(c)));
        row.appendChild(button('Custom…', 'highlight-card-custom', () => {
          closeCard(view);
          openColorDialog({ initial: isPreset(shown) ? undefined : shown, onPick: (c) => paintWith(c) });
        }));
        dom.appendChild(row);
      }
      const actions = document.createElement('div');
      actions.className = 'hl-card__actions';
      actions.appendChild(button('Select text', 'highlight-card-select', () => {
        const now = live();
        view.dispatch({ selection: EditorSelection.single(now.from, now.to), effects: setCard.of(null) });
        view.focus();
      }));
      if (cfg?.canWrite()) {
        actions.appendChild(button('Remove', 'highlight-card-remove', () => {
          const now = live();
          applyHighlight(view, [{ from: now.from, to: now.to }], { kind: 'erase' });
          closeCard(view);
          view.focus();
        }, 'hl-card__btn hl-card__btn--danger'));
      }
      dom.appendChild(actions);
      dom.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeCard(view); view.focus(); }
      });
      return {
        dom,
        mount() { if (focus) dom.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); },
      };
    },
  };
}

/** The card's field and the Escape key chain entry (KEY_CHAIN_PRIORITY.Escape.highlightCard). */
export function cardExtension(): Extension {
  return [cardField];
}
