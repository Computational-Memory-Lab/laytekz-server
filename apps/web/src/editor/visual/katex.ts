import { pokeViews } from './refresh';
import { NO_MACROS, MacroSet } from './preamble';

/**
 * Lazy KaTeX: loaded (with its CSS) only when visual mode first renders math,
 * as its own Vite chunk — the source-mode bundle is untouched. Until the
 * module arrives, math widgets show styled raw source; registered views get a
 * re-measure poke when rendering becomes available.
 */
type Katex = typeof import('katex').default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;

export function ensureKatex(): void {
  if (katex || loading) return;
  // @ts-expect-error -- CSS import is handled by Vite, not TS
  loading = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([mod]) => {
      katex = mod.default;
      pokeViews(); // the widgets drawn so far are raw source; this redraws them
    })
    .catch(() => { loading = null; });
}

/** False until the chunk has arrived: a math widget drawn before that shows raw source. */
export function katexReady(): boolean {
  return katex !== null;
}

// Galley: V2 math hover (WP13) waiting for KaTeX, its errors as data, mhchem on demand, upright aliases.
/** Starts the load if needed; resolves true once KaTeX can render, false when the chunk failed to load. */
export function katexLoaded(): Promise<boolean> {
  if (katex) return Promise.resolve(true);
  ensureKatex();
  const pending = loading;
  return pending ? pending.then(() => katex !== null) : Promise.resolve(katex !== null);
}

let mhchem: Promise<void> | null = null;

/** Loads `katex/contrib/mhchem` (\ce, \pu) once KaTeX is in; formulas drawn before it are drawn again. */
export function ensureMhchem(): Promise<void> {
  if (mhchem) return mhchem;
  mhchem = katexLoaded()
    .then((ok) => {
      if (!ok) throw new Error('KaTeX did not load');
      // @ts-expect-error -- the contrib module ships no type declarations
      return import('katex/contrib/mhchem');
    })
    .then(() => {
      cache.clear();
      pokeViews();
    })
    .catch(() => { mhchem = null; });
  return mhchem;
}

/**
 * Commands KaTeX lacks that documents use for upright symbols (upgreek's
 * \upalpha…, unicode-math's \symup, the statistics package's output): drawn
 * with KaTeX's nearest equivalent. A preamble definition of the same name wins.
 */
const UPGREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa',
  'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'];
export const UPRIGHT_ALIASES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(UPGREEK.map((g) => [`\\up${g}`, `\\${g}`])),
  '\\symup': '\\mathrm{#1}',
  '\\symrm': '\\mathrm{#1}',
  '\\symbf': '\\boldsymbol{#1}',
  '\\symit': '\\mathit{#1}',
  '\\mathup': '\\mathrm{#1}',
};

function katexMacrosOf(macros: MacroSet): Record<string, string> {
  return { ...UPRIGHT_ALIASES, ...Object.fromEntries(Object.entries(macros.defs).map(([name, m]) => [`\\${name}`, m.def])) };
}

/** Why KaTeX cannot parse `source`, with where (offsets into `source`), or null when it can (or is not loaded yet). */
export function mathError(source: string, displayMode: boolean, macros: MacroSet = NO_MACROS): { message: string; position: number | null; length: number } | null {
  if (!katex) return null;
  try {
    katex.renderToString(source, { displayMode, throwOnError: true, output: 'mathml', macros: katexMacrosOf(macros) });
    return null;
  } catch (err) {
    const e = err as { rawMessage?: string; message?: string; position?: number; length?: number };
    const message = (e.rawMessage ?? e.message ?? String(err)).replace(/^KaTeX parse error: /, '');
    return { message, position: typeof e.position === 'number' ? e.position : null, length: typeof e.length === 'number' ? e.length : 0 };
  }
}
// Galley: end V2 math hover (WP13)

/** What KaTeX draws it cannot typeset in: muted, not an alarm. The widget's title says why. */
export const UNDRAWN_COLOR = 'var(--text-2)';

const cache = new Map<string, string>();
const CACHE_MAX = 500;

/**
 * Each distinct macro set gets a short id, so cache keys stay short. Typing
 * a definition makes a new set per keystroke: past MACRO_SETS_MAX the ids
 * and the renderings made with them go, and ids are never reused.
 */
const macroIds = new Map<string, number>();
const MACRO_SETS_MAX = 16;
let nextMacroId = 1;
function macroId(macros: MacroSet): number {
  if (macros === NO_MACROS || !macros.key) return 0;
  let id = macroIds.get(macros.key);
  if (id !== undefined) return id;
  if (macroIds.size >= MACRO_SETS_MAX) {
    macroIds.clear();
    for (const k of [...cache.keys()]) if (!/^[DI]0:/.test(k)) cache.delete(k);
  }
  macroIds.set(macros.key, id = nextMacroId++);
  return id;
}

/** Rendered HTML for a math source, or null while KaTeX is still loading. */
export function renderMath(source: string, displayMode: boolean, macros: MacroSet = NO_MACROS): string | null {
  if (!katex) { ensureKatex(); return null; }
  const key = `${displayMode ? 'D' : 'I'}${macroId(macros)}:${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    // \label{} and \tag-less refs are invisible in real typeset output; KaTeX
    // would render them as red fallback text, so strip them (rendering only —
    // the source is never touched).
    const cleaned = source.replace(/\\label\s*\{[^}]*\}/g, '');
    // MathML is what screen readers read; KaTeX hides its HTML copy from them
    // a fresh map each time: KaTeX writes \gdef definitions into the one it gets
    const katexMacros = katexMacrosOf(macros); // Galley: V2 math hover (WP13) plus the upright aliases
    html = katex.renderToString(cleaned, { displayMode, throwOnError: false, errorColor: UNDRAWN_COLOR, output: 'htmlAndMathml', macros: katexMacros });
  } catch {
    return ''; // signals render failure → widget falls back to raw source
  }
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, html);
  return html;
}
