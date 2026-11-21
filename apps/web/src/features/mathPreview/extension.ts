import { Facet, StateEffect, StateField, type EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, closeHoverTooltip, hoverTooltip, showTooltip, type Tooltip } from '@codemirror/view';
import { ensureKatex } from '../../editor/visual/katex';
import { caretTarget, hoverTarget, sameTarget, type PreviewTarget } from './target';
import { previewView, type PreviewSize } from './render';

/**
 * Formula preview in the editor: on hover, while the caret is in a formula
 * (when that setting is on), and pinned at the caret by the command. Only
 * tooltips and effects: no transaction this file makes changes the document,
 * so there is nothing to undo and a collaborator never sees anything.
 */
export interface PreviewOptions {
  delay: number;
  caret: boolean;
  paper: boolean;
  size: PreviewSize;
  filePath: string;
}

export const DEFAULT_PREVIEW_OPTIONS: PreviewOptions = { delay: 350, caret: false, paper: true, size: 'medium', filePath: '' };

const previewConfig = Facet.define<PreviewOptions, PreviewOptions>({
  combine: (values) => values[0] ?? DEFAULT_PREVIEW_OPTIONS,
});

/** true pins a preview at the caret's formula; false unpins it. */
const setPin = StateEffect.define<boolean>();
/** Escape: closes the caret's (or pinned) preview until the caret leaves that formula. */
const dismissPreview = StateEffect.define<null>();

interface CaretPreview {
  pinned: boolean;
  /** Where the formula Escape closed starts; it stays closed while the caret is in it. */
  dismissed: number | null;
  /** The formula a caret or pinned preview shows now. */
  target: PreviewTarget | null;
}

const NONE: CaretPreview = { pinned: false, dismissed: null, target: null };

export const caretPreviewField = StateField.define<CaretPreview>({
  create: () => NONE,
  update(value, tr) {
    let { pinned, dismissed } = value;
    if (dismissed !== null && tr.docChanged) dismissed = tr.changes.mapPos(dismissed, 1);
    let asked = false;
    for (const e of tr.effects) {
      if (e.is(setPin)) { pinned = e.value; asked = true; if (pinned) dismissed = null; }
      else if (e.is(dismissPreview)) { pinned = false; dismissed = value.target?.from ?? dismissed; asked = true; }
    }
    const caret = tr.state.facet(previewConfig).caret;
    const configChanged = tr.startState.facet(previewConfig) !== tr.state.facet(previewConfig);
    if (!asked && !configChanged && !tr.docChanged && !tr.selection) return value;
    if (!pinned && !caret) return value === NONE ? value : NONE;
    const target = caretTarget(tr.state);
    // the caret left the formula: a pin ends, and the next formula may open again
    if (!target) return value === NONE ? value : NONE;
    const shown = dismissed !== null && target.from === dismissed ? null : target;
    if (shown === null) pinned = false;
    else dismissed = null;
    if (pinned === value.pinned && dismissed === value.dismissed && sameTarget(shown, value.target)) return value;
    return { pinned, dismissed, target: shown };
  },
});

/** Whether a pinned preview is open in `state`. */
export function previewPinned(state: EditorState): boolean {
  return !!state.field(caretPreviewField, false)?.pinned && !!state.field(caretPreviewField, false)?.target;
}

/**
 * Pins (or, when one is pinned, closes) the preview of the formula at the
 * caret. Returns false when the caret is in no formula or the preview is off.
 */
export function pinPreview(view: EditorView): boolean {
  const field = view.state.field(caretPreviewField, false);
  if (!field) return false;
  if (field.pinned && field.target) {
    view.dispatch({ effects: setPin.of(false) });
    return true;
  }
  if (!caretTarget(view.state)) return false;
  view.dispatch({ effects: setPin.of(true) });
  return true;
}

function look(state: EditorState, pinned: boolean) {
  const o = state.facet(previewConfig);
  return { paper: o.paper, size: o.size, pinned, filePath: o.filePath };
}

const caretTooltip = showTooltip.compute([caretPreviewField], (state): Tooltip | null => {
  const { target, pinned } = state.field(caretPreviewField);
  if (!target) return null;
  return { pos: target.from, end: target.to, above: false, create: (view) => previewView(view, target, look(view.state, pinned)) };
});

/** What the pointer last did over the editor: a held button means a drag, which never previews. */
class PointerWatch {
  buttons = 0;
  target: EventTarget | null = null;
  private idle: number | null = null;

  constructor(view: EditorView) {
    // KaTeX arrives while the person reads, so the first hover draws at once
    const w = (view.dom.ownerDocument.defaultView ?? globalThis) as Window & typeof globalThis;
    const start = () => { this.idle = null; ensureKatex(); };
    this.idle = typeof w.requestIdleCallback === 'function' ? w.requestIdleCallback(start, { timeout: 4000 }) : w.setTimeout(start, 1500);
  }

  destroy(): void {
    if (this.idle === null) return;
    const w = globalThis as Window & typeof globalThis;
    if (typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(this.idle);
    clearTimeout(this.idle);
  }
}

const pointerWatch = ViewPlugin.fromClass(PointerWatch, {
  eventHandlers: {
    mousemove(e, view) {
      this.buttons = e.buttons;
      this.target = e.target;
      // the hover preview takes no pointer events, so the text under it is what the pointer is over:
      // leaving the formula closes it even where the preview covers the lines below
      const hover = view.state.facet(hoverHandle);
      const active = hover ? view.state.field(hover.active, false) : null;
      const t = active?.[0];
      if (!hover || !t) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
      if (pos < t.pos || pos > (t.end ?? t.pos)) view.dispatch({ effects: closeHoverTooltip(hover) });
    },
    mousedown(e) { this.buttons = e.buttons || 1; this.target = e.target; },
    mouseup() { this.buttons = 0; },
  },
});

/** A rendered formula in Visual mode is already drawn; the MathLive editor has the formula's attention. */
function suppressed(view: EditorView): boolean {
  const p = view.plugin(pointerWatch);
  if (p && p.buttons !== 0) return true;
  const t = p?.target;
  if (t && typeof (t as Element).closest === 'function' && (t as Element).closest('.cm-vis-math')) return true;
  return !!view.dom.ownerDocument.querySelector('.vis-math-popover');
}

/** A change inside the formula, or a click, closes a hover preview. */
function hidesHover(tr: Transaction, t: Tooltip): boolean {
  if (tr.isUserEvent('select.pointer')) return true;
  return tr.docChanged && tr.changes.touchesRange(t.pos, t.end ?? t.pos) !== false;
}

const previewTheme = EditorView.baseTheme({
  '.cm-math-preview': {
    boxSizing: 'border-box',
    maxWidth: 'min(720px, 90vw)',
    maxHeight: 'min(60vh, 480px)',
    overflow: 'hidden',
    padding: '10px 14px 6px',
    borderRadius: 'var(--radius-s, 6px)',
    background: 'var(--bg-panel-raised, var(--bg-panel, #fff))',
    color: 'var(--text, #111)',
  },
  '.cm-math-preview[data-paper="true"]': { background: '#fff', color: '#000' },
  '.cm-math-preview--hover': { pointerEvents: 'none' },
  '.cm-tooltip-hover:has(> .cm-math-preview--hover), .cm-tooltip-hover:has(.cm-math-preview--hover)': { pointerEvents: 'none' },
  '.cm-math-preview--pinned': { overflow: 'auto' },
  '.cm-math-preview__body': { overflowX: 'hidden', lineHeight: '1.3' },
  '.cm-math-preview--pinned .cm-math-preview__body': { overflowX: 'auto' },
  '.cm-math-preview__body .katex-display': { margin: '0.2em 0' },
  '.cm-math-preview__source': {
    margin: '0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 'var(--text-code, 13px)',
  },
  '.cm-math-preview__at': { background: 'transparent', color: 'inherit', textDecoration: 'underline wavy #c62828', textUnderlineOffset: '3px' },
  '.cm-math-preview__issue': { marginTop: '6px', fontFamily: 'var(--font-ui, sans-serif)', fontSize: 'var(--text-xs, 12px)', color: 'inherit', opacity: '0.85', maxWidth: '60ch' },
  '.cm-math-preview__caption': { marginTop: '4px', fontFamily: 'var(--font-ui, sans-serif)', fontSize: 'var(--text-xs, 11px)', opacity: '0.6' },
});

/** The hover extension of this editor, so Escape can close its preview. */
const hoverHandle = Facet.define<ReturnType<typeof hoverTooltip>, ReturnType<typeof hoverTooltip> | null>({
  combine: (v) => v[0] ?? null,
});

/** The preview's editor extension, built from the settings (the feature host rebuilds it when one changes). */
export function mathPreviewExtension(o: PreviewOptions): Extension {
  const hover = hoverTooltip((view, pos, side) => {
    if (suppressed(view)) return null;
    const t = hoverTarget(view.state, pos, side < 0 ? -1 : 1);
    if (!t) return null;
    // the caret's own preview of the same formula is already open
    if (sameTarget(view.state.field(caretPreviewField).target, t)) return null;
    return { pos: t.from, end: t.to, above: false, create: (v) => previewView(v, t, look(v.state, false)) };
  }, { hoverTime: o.delay, hideOn: hidesHover });
  return [previewConfig.of(o), caretPreviewField, caretTooltip, hover, pointerWatch, previewTheme, hoverHandle.of(hover)];
}

/** Escape (key chain, priority 85): closes an open preview; false when none is open, so the key goes on. */
export function closePreview(view: EditorView): boolean {
  const field = view.state.field(caretPreviewField, false);
  if (field?.target) {
    view.dispatch({ effects: dismissPreview.of(null) });
    return true;
  }
  const hover = view.state.facet(hoverHandle);
  if (hover && view.state.field(hover.active, false)?.length) {
    view.dispatch({ effects: closeHoverTooltip(hover) });
    return true;
  }
  return false;
}
