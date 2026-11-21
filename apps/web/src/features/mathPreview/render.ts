import type { EditorState } from '@codemirror/state';
import type { EditorView, Rect, TooltipView } from '@codemirror/view';
import { ensureMhchem, katexLoaded, katexReady, mathError, renderMath } from '../../editor/visual/katex';
import { rootPreambleText, withIncludes } from '../../editor/visual/context';
import { NO_MACROS, documentFontSize, loadedPackages, macrosUsedBy, preambleMacros, preambleOf, type MacroSet } from '../../editor/visual/preamble';
import type { PreviewTarget } from './target';
import { bestTier, previewTiers } from './tiers';

export type PreviewSize = 'small' | 'medium' | 'large';

/** CSS pixels per typeset point: Small is the page's actual size on a usual screen. */
export const PX_PER_PT: Record<PreviewSize, number> = { small: 1.33, medium: 1.75, large: 2.25 };

/** KaTeX draws its formulas at 1.21em of the text around them. */
const KATEX_EM = 1.21;

/** Under this, a wide formula scrolls (in a pinned preview) rather than shrinking further. */
const MIN_SHRINK = 0.6;

export interface PreviewLook {
  paper: boolean;
  size: PreviewSize;
  pinned: boolean;
  filePath: string;
}

/** What the document around a formula provides: its macros, body font size, and whether it loads mhchem. */
export interface DocInfo { macros: MacroSet; fontPt: number; chem: boolean }

/** The head of the file a preamble can be in: a later \begin{document} is no preamble anyone writes. */
const PREAMBLE_SCAN = 200_000;

let memo: { key: string | null; info: DocInfo } | null = null;

/** The macros and font size the formulas of `state` are typeset with: its own preamble, or the root file's, with what they \input. */
export function docInfo(state: EditorState): DocInfo {
  const own = preambleOf(state.doc.sliceString(0, Math.min(state.doc.length, PREAMBLE_SCAN)));
  const full = withIncludes(own ?? rootPreambleText());
  if (memo && memo.key === full) return memo.info;
  const info: DocInfo = full === null
    ? { macros: NO_MACROS, fontPt: 10, chem: false }
    : { macros: preambleMacros(full), fontPt: documentFontSize(full), chem: ['mhchem', 'chemformula'].some((p) => loadedPackages(full).has(p)) };
  memo = { key: full, info };
  return info;
}

/** Commands KaTeX drew as their own name, because nothing it was given defines them. */
export function unknownCommands(html: string): string[] {
  const marked = /mathcolor="[^"]*"><mtext>(\\[A-Za-z@]+)/g;
  return [...new Set([...html.matchAll(marked)].map((m) => m[1]))];
}

/** The sentence a preview shows under a drawing KaTeX could only partly make, or null. */
export function issueText(html: string): string | null {
  const unknown = unknownCommands(html);
  return unknown.length ? `Can't draw ${unknown.join(', ')}: not defined in the preamble or in the files it inputs, so shown as written.` : null;
}

let chemLoaded = false;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The source in monospace, with KaTeX's error position underlined when it falls inside the text. */
function sourceBlock(source: string, at: number | null, length: number): HTMLElement {
  const pre = el('pre', 'cm-math-preview__source');
  if (at !== null && at >= 0 && at < source.length) {
    const end = Math.min(source.length, at + Math.max(1, length));
    const mark = el('mark', 'cm-math-preview__at', source.slice(at, end));
    pre.append(source.slice(0, at), mark, source.slice(end));
  } else {
    pre.textContent = source;
  }
  return pre;
}

/**
 * The preview's DOM for one target: KaTeX's drawing (once it has loaded),
 * then whatever a better tier offers. Always text, never an empty box.
 */
export function previewView(view: EditorView, target: PreviewTarget, look: PreviewLook): TooltipView {
  const dom = el('div', `cm-math-preview cm-math-preview--${look.pinned ? 'pinned' : 'hover'}`);
  dom.dataset.testid = 'math-preview';
  dom.dataset.tier = 'katex';
  dom.dataset.paper = look.paper ? 'true' : 'false';
  if (look.pinned) {
    dom.setAttribute('role', 'status');
    dom.setAttribute('aria-live', 'polite');
    dom.dataset.pinned = 'true';
  }
  const body = el('div', 'cm-math-preview__body');
  const issue = el('div', 'cm-math-preview__issue');
  issue.dataset.testid = 'math-preview-issue';
  const caption = el('div', 'cm-math-preview__caption');
  dom.append(body, issue, caption);

  const pxPerPt = PX_PER_PT[look.size] ?? PX_PER_PT.medium;
  const captionText = (words: string) => (look.pinned ? `${words} · Esc closes` : words);
  let destroyed = false;
  let mounted = false;
  const abort = new AbortController();

  const say = (text: string | null) => {
    issue.textContent = text ?? '';
    issue.hidden = !text;
  };

  let basePx = 0;
  const fit = () => {
    if (!mounted || dom.dataset.tier !== 'katex' || !basePx) return;
    const katexEl = body.querySelector<HTMLElement>('.katex');
    if (!katexEl) return;
    body.style.fontSize = `${basePx}px`;
    const room = body.clientWidth;
    const need = katexEl.scrollWidth;
    if (room > 0 && need > room) body.style.fontSize = `${basePx * Math.max(MIN_SHRINK, room / need)}px`;
  };

  const upgrade = () => {
    if (!previewTiers().length) return;
    void bestTier({ view, filePath: look.filePath, target, pxPerPt, paper: look.paper, signal: abort.signal }).then((r) => {
      if (!r || destroyed) return;
      dom.style.minHeight = `${dom.offsetHeight}px`;
      body.replaceChildren(r.dom);
      body.style.removeProperty('font-size');
      dom.dataset.tier = r.tier;
      say(null);
      caption.textContent = captionText(r.caption ?? 'Preview');
      if (r.title) caption.title = r.title;
    });
  };

  const fill = () => {
    if (destroyed) return;
    caption.textContent = captionText('Preview');
    if (target.tooLong) {
      body.replaceChildren();
      say('Too long to preview. Typeset and look in the PDF.');
      upgrade();
      return;
    }
    if (!katexReady()) {
      body.replaceChildren(sourceBlock(target.source, null, 0));
      say(null);
      caption.textContent = captionText('Loading the preview…');
      void katexLoaded().then((ok) => {
        if (destroyed) return;
        if (ok) fill();
        else { caption.textContent = captionText('Preview'); say("The preview could not load. Reload the page to try again."); }
      });
      return;
    }
    const info = docInfo(view.state);
    if (!chemLoaded && (info.chem || /\\(?:ce|pu)(?![A-Za-z])/.test(target.source))) {
      void ensureMhchem().then(() => { chemLoaded = true; fill(); });
      chemLoaded = true; // one attempt per page: a failed load draws \ce as unknown
    }
    const macros = macrosUsedBy(target.source, info.macros);
    const html = renderMath(target.source, target.display, macros);
    if (html === null) return; // not loaded after all: katexReady said otherwise
    basePx = (info.fontPt * pxPerPt) / KATEX_EM;
    if (!html || html.includes('katex-error')) {
      const err = mathError(target.source, target.display, macros);
      body.replaceChildren(sourceBlock(target.source, err?.position ?? null, err?.length ?? 0));
      basePx = 0;
      body.style.removeProperty('font-size');
      say(`Can't draw this formula${err ? `: ${err.message}` : ''}`);
    } else {
      body.innerHTML = html;
      body.style.fontSize = `${basePx}px`;
      say(issueText(html));
      fit();
    }
    upgrade();
  };

  fill();

  return {
    dom,
    // a display is read top to bottom: the preview goes under its last line, not over the formula
    getCoords: target.display ? (pos: number): Rect => {
      const start = view.coordsAtPos(pos, 1);
      const end = view.coordsAtPos(Math.min(view.state.doc.length, pos + (target.to - target.from)), -1);
      if (!start || !end) return (start ?? end) as Rect;
      return { left: start.left, right: start.left + 1, top: end.top, bottom: end.bottom };
    } : undefined,
    mount() { mounted = true; fit(); },
    destroy() { destroyed = true; abort.abort(); },
  };
}
