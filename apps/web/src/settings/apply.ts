/**
 * Apply (WP02 settings-core): what the appearance and typography settings do
 * to the page. They become attributes and CSS variables on <html>, which the
 * three CSS entry files and the editor themes read:
 *
 * - `data-theme` (light | dark), and the browser chrome's theme-color;
 * - `style.fontSize` on <html> (interface text size; the type scale is in rem);
 * - `data-contrast="more"`, `data-motion="reduce"`: the user's override of
 *   the matching media queries (theme.css, app.css and home.css repeat their
 *   media blocks under these);
 * - `data-pdf-dark="dim|invert"` (only drawn in the dark theme);
 * - `data-ligatures="on|off"` (absent: the browser's default, which is what
 *   the system monospace fonts already give);
 * - `--editor-font`, `--editor-font-size`, `--editor-line-height`,
 *   `--visual-font-size`, `--visual-width`, set only while they differ from
 *   the defaults theme.css declares.
 *
 * index.html's pre-paint applies the theme, size, contrast and motion before
 * first paint; this keeps them, and the rest, in step afterwards.
 */
import type { Appearance } from './codecs';

export type Theme = 'light' | 'dark';

/** Each theme's --bg-app, for the browser's own chrome. index.html's pre-paint repeats these. */
export const THEME_COLOR: Record<Theme, string> = { dark: '#1c1c1e', light: '#f5f5f7' };

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(appearance: Appearance, systemDark: boolean): Theme {
  if (appearance === 'system') return systemDark ? 'dark' : 'light';
  return appearance;
}

export function darkMedia(): MediaQueryList | null {
  try { return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DARK_QUERY) : null; } catch { return null; }
}

/** Without a media query to ask, "system" paints dark, as the pre-paint does. */
export function systemIsDark(): boolean {
  return darkMedia()?.matches ?? true;
}

let painted: Theme | null = null;

/** Puts `t` on screen. Only an actual change cross-fades: a view transition
 *  freezes input for its duration, and re-selecting the current theme should
 *  cost nothing. */
export function paintTheme(t: Theme, animate: boolean): void {
  painted = t;
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const apply = () => {
    root.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (animate && doc.startViewTransition && root.dataset.theme !== t) doc.startViewTransition(apply);
  else apply();
}

/** The theme last handed to paintTheme (null before the first), even while its cross-fade is still pending. */
export function paintedTheme(): Theme | null {
  return painted;
}

/** The settings this module applies, besides the theme. */
export const APPLIED_IDS = [
  'appearance.scale', 'appearance.contrast', 'appearance.motion', 'pdf.dark',
  'editor.font', 'editor.fontSize', 'editor.lineHeight', 'editor.ligatures', 'visual.fontSize', 'visual.width',
] as const;

export interface AppliedLook {
  /** <html>'s inline font-size: '' for the browser's own size. */
  fontSize: string;
  /** dataset keys (camelCase) → value; null removes the attribute. */
  attrs: { contrast: string | null; motion: string | null; pdfDark: string | null; ligatures: string | null };
  /** CSS custom properties → value; null removes the inline value (theme.css's default applies). */
  vars: Record<'--editor-font' | '--editor-font-size' | '--editor-line-height' | '--visual-font-size' | '--visual-width', string | null>;
}

const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const fontName = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9 _-]+$/.test(v) ? v.trim() : '');

/** What the settings ask of <html>; `get` returns a setting's effective value. */
export function lookOf(get: (id: string) => unknown): AppliedLook {
  const scale = num(get('appearance.scale'), 100);
  const font = fontName(get('editor.font'));
  const fontSize = num(get('editor.fontSize'), 13.5);
  const lineHeight = num(get('editor.lineHeight'), 1.55);
  const visualSize = num(get('visual.fontSize'), 16);
  const pdfDark = get('pdf.dark');
  const ligatures = get('editor.ligatures') === true;
  return {
    fontSize: scale === 100 ? '' : `${scale}%`,
    attrs: {
      contrast: get('appearance.contrast') === 'more' ? 'more' : null,
      motion: get('appearance.motion') === 'reduce' ? 'reduce' : null,
      pdfDark: pdfDark === 'dim' || pdfDark === 'invert' ? pdfDark : null,
      // Off only matters for a chosen font: the system monospace fonts have no ligatures to turn off.
      ligatures: ligatures ? 'on' : font ? 'off' : null,
    },
    vars: {
      '--editor-font': font ? `"${font}", var(--font-mono)` : null,
      '--editor-font-size': fontSize === 13.5 ? null : `${fontSize}px`,
      '--editor-line-height': lineHeight === 1.55 ? null : String(lineHeight),
      '--visual-font-size': visualSize === 16 ? null : `${visualSize}px`,
      '--visual-width': get('visual.width') === 'full' ? 'none' : null,
    },
  };
}

/** The parts of an element this module writes (an HTMLElement, or a test double). */
export interface LookTarget {
  dataset: Record<string, string | undefined>;
  style: { fontSize: string; setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}

export function applyLook(root: LookTarget, look: AppliedLook): void {
  if (root.style.fontSize !== look.fontSize) root.style.fontSize = look.fontSize;
  for (const [k, v] of Object.entries(look.attrs)) {
    if (v === null) delete root.dataset[k];
    else if (root.dataset[k] !== v) root.dataset[k] = v;
  }
  for (const [k, v] of Object.entries(look.vars)) {
    if (v === null) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
}

let started = false;

/**
 * Keeps <html> on the settings from now on: paints the theme and the look
 * now, again whenever one of them changes (this tab, another tab, the
 * account), and follows the system's dark mode while the theme is "Match
 * system". Once per tab; later calls do nothing.
 */
export function startApply(get: (id: string) => unknown, subscribe: (ids: string[], fn: () => void) => () => void): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  const root = document.documentElement as unknown as LookTarget;
  const theme = () => resolveTheme((get('appearance.theme') as Appearance) ?? 'system', systemIsDark());
  paintTheme(theme(), false);
  applyLook(root, lookOf(get));
  // A change from this tab has painted already (theme.ts setAppearance, with its cross-fade).
  subscribe(['appearance.theme'], () => { const t = theme(); if (t !== painted) paintTheme(t, false); });
  darkMedia()?.addEventListener('change', () => { if (get('appearance.theme') === 'system') paintTheme(theme(), true); });
  subscribe([...APPLIED_IDS], () => applyLook(root, lookOf(get)));
}
