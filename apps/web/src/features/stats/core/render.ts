import { APA7, type StatsStyle } from './style';
import { formatValue, type Kind } from './format';
import type { StatEntry } from './catalogue';

/**
 * Renders a catalogue template to LaTeX, with the field ranges the editor
 * needs (feature 16).
 * - prose: each statistic in its own `$…$`, text runs as text with ties;
 * - math (inside `$…$`, `\[…\]`, equation, align…): no `$`, text runs become
 *   `\mathrm{…}` joined by `\ `; nothing needs amsmath;
 * - cell: like prose; with `sColumn` the values are braced so siunitx adds no zero.
 */

export type InsertContext = 'prose' | 'math' | 'cell';
export type GreekMode = 'italic' | 'upgreek' | 'unicode-math';

export interface RenderOptions {
  context?: InsertContext;
  style?: StatsStyle;
  /** How lowercase Greek is written; greekMode() picks it from the style and the preamble. */
  greek?: GreekMode;
  /** Raw field text by label; a missing label takes the field's prefilled value or stays empty. */
  values?: Readonly<Record<string, string | undefined>>;
  /** false keeps the values exactly as given (the "format as I leave a field" switch off). */
  format?: boolean;
  /** Remove optional parts whose fields are all empty. */
  prune?: boolean;
  /** The cell sits in a siunitx S column. */
  sColumn?: boolean;
  /** Per-label kind overrides (a CI after a correlation takes bounded values). */
  kinds?: Readonly<Record<string, Kind>>;
}

export interface RenderedField {
  label: string;
  kind: Kind;
  /** Offsets of the field's text in `text` (equal when empty). */
  from: number;
  to: number;
  /** Index of the optional part holding it, or null. */
  optional: number | null;
  warning?: string;
}

export interface Rendered { text: string; fields: RenderedField[] }

type Token =
  | { t: 'text'; s: string }
  | { t: 'math' }
  | { t: 'field'; label: string; kind: Kind; def?: string }
  | { t: 'opt'; open: boolean }
  | { t: 'var'; name: 'KW' | 'CRI' };

export interface TemplateField { label: string; kind: Kind; def?: string; optional: number | null }

const tokenCache = new Map<string, Token[]>();

export function tokenize(template: string): Token[] {
  const hit = tokenCache.get(template);
  if (hit) return hit;
  const out: Token[] = [];
  const re = /⟦([^:⟧]+):([A-Z]+)(?:=([^⟧]*))?⟧|⟪|⟫|⟨(KW|CRI)⟩|\$/g;
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) out.push({ t: 'text', s: template.slice(last, m.index) });
    last = re.lastIndex;
    if (m[0] === '$') out.push({ t: 'math' });
    else if (m[0] === '⟪' || m[0] === '⟫') out.push({ t: 'opt', open: m[0] === '⟪' });
    else if (m[4]) out.push({ t: 'var', name: m[4] as 'KW' | 'CRI' });
    else out.push({ t: 'field', label: m[1], kind: m[2] as Kind, ...(m[3] !== undefined ? { def: m[3] } : {}) });
  }
  if (last < template.length) out.push({ t: 'text', s: template.slice(last) });
  tokenCache.set(template, out);
  return out;
}

/** The fields of a template in textual order. */
export function templateFields(template: string): TemplateField[] {
  const out: TemplateField[] = [];
  let opt = -1, inOpt = false;
  for (const tk of tokenize(template)) {
    if (tk.t === 'opt') { inOpt = tk.open; if (tk.open) opt++; }
    else if (tk.t === 'field') out.push({ label: tk.label, kind: tk.kind, ...(tk.def !== undefined ? { def: tk.def } : {}), optional: inOpt ? opt : null });
  }
  return out;
}

const GREEK = /\\(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)(?![A-Za-z])/g;

export function greekify(s: string, mode: GreekMode): string {
  if (mode === 'italic') return s;
  return s.replace(GREEK, mode === 'upgreek' ? '\\up$1' : '\\symup{\\$1}');
}

/** Upright Greek where the preamble provides it (upgreek or unicode-math), otherwise LaTeX's italic. */
export function greekMode(style: StatsStyle, packages: { upgreek?: boolean; unicodeMath?: boolean } = {}): GreekMode {
  if (style.greek === 'italic') return 'italic';
  if (packages.unicodeMath) return 'unicode-math';
  if (packages.upgreek) return 'upgreek';
  return style.greek === 'upright' ? 'upgreek' : 'italic';
}

/** A prose text run written inside math: words upright, spaces explicit. */
export function textToMath(s: string): string {
  return s.replace(/\\textsuperscript\{([^}]*)\}|\\[A-Za-z]+|\\.|--|[A-Za-z]+|~|, | /g, (m, sup: string | undefined) => {
    if (sup !== undefined) return `^{${sup}}`;
    if (m.startsWith('\\')) return m;
    if (m === '--') return '\\mbox{--}';
    if (m === '~' || m === ' ') return '\\ ';
    if (m === ', ') return ',\\ ';
    return `\\mathrm{${m}}`;
  });
}

/** Renders any template (catalogue entries, or the converter's pieces). */
export function renderTemplate(template: string, o: RenderOptions = {}): Rendered {
  const style = o.style ?? APA7;
  const context = o.context ?? 'prose';
  const greek = o.greek ?? 'italic';
  const tokens = tokenize(template);
  const fields = templateFields(template);
  const rawOf = (f: TemplateField) => o.values?.[f.label] ?? f.def ?? '';
  const emptyGroups = new Set<number>();
  if (o.prune) {
    const groups = new Set(fields.filter((f) => f.optional !== null).map((f) => f.optional!));
    for (const g of groups) if (fields.filter((f) => f.optional === g).every((f) => !rawOf(f).trim())) emptyGroups.add(g);
  }

  let text = '';
  const out: RenderedField[] = [];
  let inMath = false, opt = -1, inOpt = false, fieldIndex = 0;
  for (const tk of tokens) {
    if (tk.t === 'opt') { inOpt = tk.open; if (tk.open) opt++; continue; }
    const skipping = inOpt && emptyGroups.has(opt);
    if (tk.t === 'math') { inMath = !inMath; if (!skipping && context !== 'math') text += '$'; continue; }
    if (tk.t === 'field') {
      const f = fields[fieldIndex++];
      if (skipping) continue;
      const kind = o.kinds?.[f.label] ?? f.kind;
      const raw = rawOf(f);
      const fmt = o.format === false ? { text: raw.trim(), warning: undefined } : formatValue(kind, raw, style);
      let value = fmt.text;
      if (context === 'math' && kind === 'PC') value = value.replace(/\$([<>])\$/, '$1');
      let pre = '', post = '';
      if (context === 'cell' && o.sColumn && !inMath && value) { pre = '{'; post = '}'; }
      if (!inMath && context !== 'math' && /^-/.test(value)) { pre = '$'; post = '$'; }
      text += pre;
      const from = text.length;
      text += value;
      out.push({ label: f.label, kind, from, to: text.length, optional: inOpt ? opt : null, ...(fmt.warning ? { warning: fmt.warning } : {}) });
      text += post;
      continue;
    }
    if (skipping) continue;
    let s = tk.t === 'var'
      ? (tk.name === 'KW' ? (style.kruskalSymbol === 'chi2' ? '\\chi^2' : 'H') : style.credibleLabel)
      : tk.s;
    if (inMath) s = greekify(s, greek);
    else if (context === 'math') s = textToMath(s);
    text += s;
  }
  return { text, fields: out };
}

export const render = (entry: StatEntry, o: RenderOptions = {}): Rendered => renderTemplate(entry.template, o);

/** Joins rendered statistics with ", " (",\ " inside math), shifting the field offsets. */
export function joinRendered(parts: readonly Rendered[], context: InsertContext = 'prose'): Rendered {
  const sep = context === 'math' ? ',\\ ' : ', ';
  let text = '';
  const fields: RenderedField[] = [];
  parts.forEach((p, i) => {
    if (i) text += sep;
    const base = text.length;
    for (const f of p.fields) fields.push({ ...f, from: f.from + base, to: f.to + base });
    text += p.text;
  });
  return { text, fields };
}

const SAMPLE_BY_LABEL: Record<string, string> = {
  lower: '0.12', upper: '0.45', df1: '2', df2: '45', min: '1', max: '7', k: '18', n: '25', N: '120',
};
const SAMPLE_BY_KIND: Record<Kind, string> = {
  P: '0.028', PC: '0.015', B: '.42', U: '2.31', M: '4.52', DF: '28', N: '120', BF: '3.21', PCT: '37.5', LVL: '95', PT: '.05', RAW: '2, 1',
};

/** The entry with example numbers, for previews ("p = .028"). */
export function sample(entry: StatEntry, o: Omit<RenderOptions, 'values'> = {}): string {
  const values: Record<string, string> = {};
  for (const f of templateFields(entry.template)) {
    values[f.label] = f.def ?? (f.kind === 'B' && SAMPLE_BY_LABEL[f.label] ? SAMPLE_BY_LABEL[f.label].replace(/^0/, '') : SAMPLE_BY_LABEL[f.label] ?? SAMPLE_BY_KIND[f.kind]);
  }
  return renderTemplate(entry.template, { ...o, values }).text;
}
