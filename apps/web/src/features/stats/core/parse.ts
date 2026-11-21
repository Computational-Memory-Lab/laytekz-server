import { CATALOGUE } from './catalogue';
import type { Kind } from './format';
import { APA7, type StatsStyle } from './style';
import {
  joinRendered, renderTemplate, tokenize, type GreekMode, type Rendered, type RenderedField,
} from './render';

/**
 * The statistics converter (feature 16): recognises R, SciPy, BayesFactor and
 * APA-like text output and rewrites it in the house style. It only reformats
 * what is there: nothing is computed, values that are missing become empty
 * fields, and text it does not recognise is left untouched.
 */

export interface Piece { template: string; values: Record<string, string>; kinds?: Record<string, Kind> }
export type Source = 'r' | 'scipy' | 'bayesfactor' | 'model' | 'text';
export interface Recognised { from: number; to: number; pieces: Piece[]; source: Source }

export interface ConvertOptions { style?: StatsStyle; greek?: GreekMode }
export interface Converted {
  text: string;
  /** Recognised blocks replaced. */
  count: number;
  /** Fields in the new text; empty ones are values the output did not contain (the chi-square N). */
  fields: RenderedField[];
}

const CI_T = (k: Kind) => String.raw`⟦level:LVL=95⟧\%~CI~$[⟦lower:${k}⟧, ⟦upper:${k}⟧]$`;
const T = {
  t: String.raw`$t(⟦df:DF⟧) = ⟦t:U⟧$`,
  F: String.raw`$F(⟦df1:DF⟧, ⟦df2:DF⟧) = ⟦F:U⟧$`,
  chisq: String.raw`$\chi^2(⟦df:DF⟧, N = ⟦N:N⟧) = ⟦chisq:U⟧$`,
  chisqDf: String.raw`$\chi^2(⟦df:DF⟧) = ⟦chisq:U⟧$`,
  kw: String.raw`$⟨KW⟩(⟦df:DF⟧) = ⟦H:U⟧$`,
  friedman: String.raw`$\chi^2_{\mathrm{F}}(⟦df:DF⟧) = ⟦chisq:U⟧$`,
  p: String.raw`$p ⟦p:P⟧$`,
  r: String.raw`$r(⟦df:DF⟧) = ⟦r:B⟧$`,
  rs: String.raw`$r_{\mathrm{s}}⟪(⟦df:DF⟧)⟫ = ⟦r:B⟧$`,
  tau: String.raw`$\tau_{\mathrm{b}} = ⟦tau:B⟧$`,
  z: String.raw`$z = ⟦z:U⟧$`,
  U: String.raw`$U = ⟦U:N⟧$`,
  W: String.raw`$W = ⟦W:N⟧$`,
  Wb: String.raw`$W = ⟦W:B⟧$`,
  V: String.raw`$V = ⟦V:N⟧$`,
  T: String.raw`$T = ⟦T:N⟧$`,
  bf10: String.raw`$\mathit{BF}_{10} = ⟦bf:BF⟧$`,
  rsq: String.raw`$R^2 = ⟦rsq:B⟧$`,
  rsqadj: String.raw`$R^2_{\mathrm{adj}} = ⟦rsq:B⟧$`,
  d: String.raw`$d = ⟦d:U⟧$`,
  M: String.raw`$M = ⟦M:M⟧$`,
  SD: String.raw`$\mathit{SD} = ⟦SD:M⟧$`,
  eta: String.raw`$\eta^2 = ⟦eta:B⟧$`,
  etap: String.raw`$\eta^2_{\mathrm{p}} = ⟦eta:B⟧$`,
  binom: String.raw`⟦k:N⟧ of ⟦n:N⟧, binomial`,
};

const piece = (template: string, values: Record<string, string | undefined>, kinds?: Record<string, Kind>): Piece => {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) clean[k] = v.trim();
  return kinds ? { template, values: clean, kinds } : { template, values: clean };
};
const pPiece = (p: string | undefined) => piece(T.p, { p });
const ciPiece = (level: string | undefined, lower: string, upper: string, k: Kind) =>
  piece(CI_T(k), { level: level ?? '95', lower, upper });

/** Unicode minus signs and non-breaking spaces made plain, one character for one, so offsets still match the input. */
export function normalise(text: string): string {
  return text
    .replace(/[\u2212\u2012\u2013\uFE63\uFF0D](?=\s*[\d.])/g, '-')
    .replace(/[\u00A0\u2009\u202F]/g, ' ');
}

// ---------- R htest print blocks ----------

const LINE_RE = /[^\n]*\n?/g;
function linesOf(text: string): { s: string; from: number; to: number }[] {
  const out: { s: string; from: number; to: number }[] = [];
  LINE_RE.lastIndex = 0;
  for (let m = LINE_RE.exec(text); m && m[0]; m = LINE_RE.exec(text)) {
    const s = m[0].replace(/\r?\n$/, '');
    out.push({ s, from: m.index, to: m.index + s.length });
  }
  return out;
}

const NUM = String.raw`[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?`;

function statPairs(line: string): Record<string, string> | null {
  if (!/p-value\s*[<=>]/.test(line)) return null;
  const out: Record<string, string> = {};
  for (const part of line.split(/,\s*/)) {
    const m = /^\s*(.+?)\s*([=<>])\s*(\S+)\s*$/.exec(part);
    if (!m) continue;
    out[m[1]] = m[1] === 'p-value' ? (m[2] === '=' ? m[3] : `${m[2]} ${m[3]}`) : m[3];
  }
  return out['p-value'] ? out : null;
}

function recogniseR(text: string): Recognised[] {
  const lines = linesOf(text);
  const out: Recognised[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stats = statPairs(lines[i].s);
    if (!stats || /F-statistic/.test(lines[i].s)) continue;
    // Header: the non-empty line before "data:", within a few lines above.
    let start = i, header = '';
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (/^\s*data:/.test(lines[j].s)) {
        start = j;
        for (let h = j - 1; h >= Math.max(0, j - 3); h--) if (lines[h].s.trim()) { header = lines[h].s.trim(); start = h; break; }
        break;
      }
    }
    let end = i, level: string | undefined, ci: [string, string] | undefined, estimate: { name: string; value: string } | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[j].s;
      if (!s.trim()) continue;
      if (/^\s*alternative hypothesis/.test(s)) { end = j; continue; }
      const lv = /^\s*(\d+(?:\.\d+)?) percent confidence interval:/.exec(s);
      if (lv && j + 1 < lines.length) {
        const nums = lines[j + 1].s.match(new RegExp(NUM, 'g'));
        if (nums && nums.length >= 2) { level = lv[1]; ci = [nums[0], nums[1]]; end = j + 1; j++; }
        if (j + 1 < lines.length && /^\s*attr\(,"conf\.level"\)/.test(lines[j + 1].s)) { end = j + 2; j += 2; }
        continue;
      }
      if (/^\s*sample estimates:/.test(s) && j + 2 < lines.length) {
        const names = lines[j + 1].s.trim(), values = lines[j + 2].s.match(new RegExp(NUM, 'g'));
        if (values?.length) estimate = { name: names, value: values[values.length - 1] };
        end = j + 2; j += 2;
        continue;
      }
      break;
    }
    const p = stats['p-value'];
    const df = stats.df;
    const pieces: Piece[] = [];
    if (stats.t !== undefined) {
      if (/correlation/i.test(header) && estimate) {
        pieces.push(piece(T.r, { df, r: estimate.value }));
        if (ci) pieces.push(ciPiece(level, ci[0], ci[1], 'B'));
        pieces.push(pPiece(p));
      } else {
        pieces.push(piece(T.t, { df, t: stats.t }), pPiece(p));
        if (ci) pieces.push(ciPiece(level, ci[0], ci[1], 'U'));
      }
    } else if (stats['X-squared'] !== undefined || stats["McNemar's chi-squared"] !== undefined) {
      pieces.push(piece(T.chisq, { df, chisq: stats['X-squared'] ?? stats["McNemar's chi-squared"] }), pPiece(p));
    } else if (stats['Kruskal-Wallis chi-squared'] !== undefined) {
      pieces.push(piece(T.kw, { df, H: stats['Kruskal-Wallis chi-squared'] }), pPiece(p));
    } else if (stats['Friedman chi-squared'] !== undefined) {
      pieces.push(piece(T.friedman, { df, chisq: stats['Friedman chi-squared'] }), pPiece(p));
    } else if (stats.F !== undefined && stats['num df'] !== undefined) {
      pieces.push(piece(T.F, { df1: stats['num df'], df2: stats['denom df'], F: stats.F }), pPiece(p));
    } else if (stats.W !== undefined) {
      pieces.push(piece(/shapiro/i.test(header) ? T.Wb : T.W, { W: stats.W }), pPiece(p));
    } else if (stats.V !== undefined) {
      pieces.push(piece(T.V, { V: stats.V }), pPiece(p));
    } else if (/spearman/i.test(header) && estimate) {
      pieces.push(piece(T.rs, { r: estimate.value }), pPiece(p));
    } else if (/kendall/i.test(header) && estimate) {
      pieces.push(piece(T.tau, { tau: estimate.value }), pPiece(p));
    } else if (stats['number of successes'] !== undefined) {
      pieces.push(piece(T.binom, { k: stats['number of successes'], n: stats['number of trials'] }), pPiece(p));
    } else if (stats.z !== undefined) {
      pieces.push(piece(T.z, { z: stats.z }), pPiece(p));
    } else continue;
    out.push({ from: lines[start].from, to: lines[end].to, pieces, source: 'r' });
    i = end;
  }
  return out;
}

// ---------- R model summaries ----------

function recogniseModel(text: string): Recognised[] {
  const out: Recognised[] = [];
  const f = new RegExp(String.raw`F-statistic:\s*(${NUM}) on (\d+) and (\d+) DF,\s*p-value:\s*([<=]?\s*${NUM})`, 'g');
  for (let m = f.exec(text); m; m = f.exec(text)) {
    out.push({ from: m.index, to: m.index + m[0].length, source: 'model',
      pieces: [piece(T.F, { df1: m[2], df2: m[3], F: m[1] }), pPiece(m[4])] });
  }
  const r2 = new RegExp(String.raw`Multiple R-squared:\s*(${NUM}),\s*Adjusted R-squared:\s*(${NUM})`, 'g');
  for (let m = r2.exec(text); m; m = r2.exec(text)) {
    out.push({ from: m.index, to: m.index + m[0].length, source: 'model',
      pieces: [piece(T.rsq, { rsq: m[1] }), piece(T.rsqadj, { rsq: m[2] })] });
  }
  return out;
}

// ---------- SciPy result reprs and BayesFactor ----------

function recogniseScipy(text: string): Recognised[] {
  const out: Recognised[] = [];
  const re = /\b([A-Z][A-Za-z_0-9]*Result)\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const close = matchParen(text, m.index + m[0].length - 1);
    if (close < 0) continue;
    const inner = text.slice(m.index + m[0].length, close).replace(/np\.float(?:16|32|64)\(([^()]*)\)/g, '$1');
    re.lastIndex = close + 1;
    const args: Record<string, string> = {};
    for (const part of inner.split(/,\s*/)) {
      const kv = /^\s*([a-z_]+)\s*=\s*(\S+)\s*$/.exec(part);
      if (kv) args[kv[1]] = kv[2];
    }
    const s = args.statistic, p = args.pvalue;
    if (p === undefined) continue;
    const name = m[1];
    const df = args.df ?? args.dof;
    let pieces: Piece[] | null = null;
    if (/^T[Tt]est/.test(name)) pieces = [piece(T.t, { df, t: s })];
    else if (name === 'PearsonRResult') pieces = [piece(T.r, { df, r: s })];
    else if (name === 'SpearmanrResult') pieces = [piece(T.rs, { r: s })];
    else if (name === 'KendalltauResult') pieces = [piece(T.tau, { tau: s })];
    else if (name === 'MannwhitneyuResult') pieces = [piece(T.U, { U: s })];
    else if (name === 'WilcoxonResult') pieces = [piece(T.T, { T: s })];
    else if (name === 'KruskalResult') pieces = [piece(T.kw, { df, H: s })];
    else if (name === 'F_onewayResult') pieces = [piece(T.F, { F: s })];
    else if (name === 'ShapiroResult') pieces = [piece(T.Wb, { W: s })];
    else if (name === 'Power_divergenceResult' || name === 'Chi2ContingencyResult') pieces = [piece(T.chisq, { df, chisq: s })];
    else if (name === 'BinomTestResult') pieces = [piece(T.binom, { k: args.k, n: args.n })];
    if (!pieces) continue;
    pieces.push(pPiece(p));
    out.push({ from: m.index, to: close + 1, pieces, source: 'scipy' });
  }
  return out;
}

function recogniseBayesFactor(text: string): Recognised[] {
  const out: Recognised[] = [];
  const re = new RegExp(String.raw`\[\d+\]\s*Alt\.,[^:\n]*:\s*(${NUM})\s*±\s*[\d.]+%`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ from: m.index, to: m.index + m[0].length, pieces: [piece(T.bf10, { bf: m[1] })], source: 'bayesfactor' });
  }
  return out;
}

// ---------- APA-like plain text ----------

const V = String.raw`([-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][-+]?\d+)?)`;
const TEXT_PATTERNS: { re: RegExp; make(m: RegExpExecArray): Piece }[] = [
  { re: new RegExp(String.raw`(?<![A-Za-z\\])t\s*\(\s*${V}\s*\)\s*=\s*${V}`, 'g'), make: (m) => piece(T.t, { df: m[1], t: m[2] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])F\s*\(\s*${V}\s*,\s*${V}\s*\)\s*=\s*${V}`, 'g'), make: (m) => piece(T.F, { df1: m[1], df2: m[2], F: m[3] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])r\s*\(\s*${V}\s*\)\s*=\s*${V}`, 'g'), make: (m) => piece(T.r, { df: m[1], r: m[2] }) },
  { re: new RegExp(String.raw`(?:χ\s*2|χ²|chi2|X2|chi-square)\s*\(\s*${V}(?:\s*,\s*N\s*=\s*${V})?\s*\)\s*=\s*${V}`, 'gi'),
    make: (m) => (m[2] ? piece(T.chisq, { df: m[1], N: m[2], chisq: m[3] }) : piece(T.chisqDf, { df: m[1], chisq: m[3] })) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])p\s*(<=|>=|≤|≥|=|<|>)\s*${V}`, 'g'), make: (m) => pPiece(`${m[1]} ${m[2]}`) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])d\s*=\s*${V}`, 'g'), make: (m) => piece(T.d, { d: m[1] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])z\s*=\s*${V}`, 'g'), make: (m) => piece(T.z, { z: m[1] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])U\s*=\s*${V}`, 'g'), make: (m) => piece(T.U, { U: m[1] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])M\s*=\s*${V}`, 'g'), make: (m) => piece(T.M, { M: m[1] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])SD\s*=\s*${V}`, 'g'), make: (m) => piece(T.SD, { SD: m[1] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])BF_?(?:10|₁₀)\s*=\s*${V}`, 'g'), make: (m) => piece(T.bf10, { bf: m[1] }) },
  { re: new RegExp(String.raw`(?:ηp²|ηp2|η²p|η2p|ηₚ²|partial η²)\s*=\s*${V}`, 'g'), make: (m) => piece(T.etap, { eta: m[1] }) },
  { re: new RegExp(String.raw`(?:η²|η2)(?![p₀-₉])\s*=\s*${V}`, 'g'), make: (m) => piece(T.eta, { eta: m[1] }) },
  { re: new RegExp(String.raw`(?<![A-Za-z\\])R(?:²|2|\^2)\s*=\s*${V}`, 'g'), make: (m) => piece(T.rsq, { rsq: m[1] }) },
  { re: new RegExp(String.raw`(\d+)\s*%\s*CI\s*[\[(]\s*${V}\s*[,;]\s*${V}\s*[\])]`, 'g'), make: (m) => ciPiece(m[1], m[2], m[3], 'U') },
];

/** `$…$` spans outside comments, as [from, to) including the dollars. */
export function inlineMathSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '%' && open < 0) { const nl = text.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c !== '$') continue;
    if (text[i + 1] === '$') {
      // Display math $$…$$: skip it whole.
      const close = text.indexOf('$$', i + 2);
      if (close < 0) break;
      i = close + 1; open = -1;
      continue;
    }
    if (open < 0) open = i; else { out.push([open, i + 1]); open = -1; }
  }
  return out;
}

function recogniseText(text: string): Recognised[] {
  const math = inlineMathSpans(text);
  const inMath = (a: number, b: number) => math.some(([f, t]) => a < t && b > f);
  type Hit = { from: number; to: number; piece: Piece };
  const hits: Hit[] = [];
  for (const { re, make } of TEXT_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!inMath(m.index, m.index + m[0].length)) hits.push({ from: m.index, to: m.index + m[0].length, piece: make(m) });
    }
  }
  hits.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Hit[] = [];
  for (const h of hits) if (!kept.length || h.from >= kept[kept.length - 1].to) kept.push(h);
  const out: Recognised[] = [];
  for (const h of kept) {
    const last = out[out.length - 1];
    if (last && /^\s*[,;]?\s*(?:and\s+)?$/.test(text.slice(last.to, h.from))) {
      last.to = h.to; last.pieces.push(h.piece);
    } else out.push({ from: h.from, to: h.to, pieces: [h.piece], source: 'text' });
  }
  return out;
}

/** Every recognised block, in text order, without overlaps (output recognisers win over plain text). */
export function recognise(input: string): Recognised[] {
  const text = normalise(input);
  const strong = [...recogniseR(text), ...recogniseModel(text), ...recogniseScipy(text), ...recogniseBayesFactor(text)];
  strong.sort((a, b) => a.from - b.from);
  const blocks: Recognised[] = [];
  for (const b of strong) if (!blocks.length || b.from >= blocks[blocks.length - 1].to) blocks.push(b);
  for (const t of recogniseText(text)) if (!blocks.some((b) => t.from < b.to && t.to > b.from)) blocks.push(t);
  blocks.sort((a, b) => a.from - b.from);
  // Neighbouring output blocks (an lm's R-squared line and F line) read as one.
  const merged: Recognised[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.source === b.source && b.source !== 'text' && /^\s*$/.test(text.slice(last.to, b.from))) {
      last.to = b.to; last.pieces.push(...b.pieces);
    } else merged.push({ ...b, pieces: [...b.pieces] });
  }
  return merged;
}

function matchParen(s: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Renders a block's pieces in the style, for prose. */
export function renderPieces(pieces: readonly Piece[], o: ConvertOptions = {}): Rendered {
  return joinRendered(pieces.map((p) => renderTemplate(p.template, {
    style: o.style ?? APA7, greek: o.greek ?? 'italic', values: p.values, prune: true, ...(p.kinds ? { kinds: p.kinds } : {}),
  })));
}

/** True when the text holds program output worth offering to convert (the paste offer). */
export function looksLikeTestOutput(text: string): boolean {
  const blocks = recognise(text);
  return blocks.some((b) => b.source !== 'text') || blocks.some((b) => b.pieces.length >= 2);
}

/** Replaces every recognised block with its APA form; unrecognised text stays as it is. */
export function convertStatistics(text: string, o: ConvertOptions = {}): Converted {
  const blocks = recognise(text);
  let out = '', at = 0;
  const fields: RenderedField[] = [];
  for (const b of blocks) {
    out += text.slice(at, b.from);
    const r = renderPieces(b.pieces, o);
    for (const f of r.fields) fields.push({ ...f, from: f.from + out.length, to: f.to + out.length });
    out += r.text;
    at = b.to;
  }
  out += text.slice(at);
  return { text: out, count: blocks.length, fields };
}

// ---------- Reformat: restyle `$…$` spans that are wholly a statistic ----------

interface PiecePattern { template: string; re: RegExp; labels: string[] }

const VALUE = String.raw`-?(?:\d(?:[\d.]|\{,\}|\\,)*|\.\d+)(?:\s*\\times\s*10\^\{-?\d+\})?|\\[A-Za-z]+`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, String.raw`\s*`);

let patternCache: PiecePattern[] | null = null;
/** One pattern per distinct `$…$` segment with fields in the catalogue, in catalogue order. */
export function piecePatterns(): PiecePattern[] {
  if (patternCache) return patternCache;
  const seen = new Set<string>();
  const out: PiecePattern[] = [];
  for (const entry of CATALOGUE) {
    let inMath = false, seg = '', re = '', labels: string[] = [], hasField = false;
    for (const tk of tokenize(entry.template)) {
      if (tk.t === 'math') {
        if (inMath && hasField && !seen.has(seg)) {
          seen.add(seg);
          out.push({ template: `$${seg}$`, re: new RegExp(`^\\s*${re}\\s*$`), labels });
        }
        inMath = !inMath; seg = ''; re = ''; labels = []; hasField = false;
        continue;
      }
      if (!inMath) continue;
      if (tk.t === 'text') { seg += tk.s; re += escapeRe(tk.s); }
      else if (tk.t === 'opt') { seg += tk.open ? '⟪' : '⟫'; re += tk.open ? '(?:' : ')?'; }
      else if (tk.t === 'var') { seg += `⟨${tk.name}⟩`; re += tk.name === 'KW' ? String.raw`(?:H|\\chi\^2)` : '(?:CrI|HDI)'; }
      else {
        hasField = true;
        seg += `⟦${tk.label}:${tk.kind}${tk.def !== undefined ? `=${tk.def}` : ''}⟧`;
        labels.push(tk.label);
        re += tk.kind === 'P' ? String.raw`((?:=|<|>|\\leq?|\\geq?)\s*(?:${VALUE}))` : `(${VALUE})`;
      }
    }
  }
  patternCache = out;
  return out;
}

const UP = /\\up(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)(?![A-Za-z])/g;
const normaliseMath = (s: string) => s
  .replace(UP, '\\$1')
  .replace(/\\symup\{\\([a-z]+)\}/g, '\\$1')
  .replace(/\^\{(\d)\}/g, '^$1');

export interface Reformatted { text: string; count: number; changes: { from: number; to: number; insert: string }[] }

/**
 * Applies the style to every `$…$` that is wholly one recognised statistic.
 * Spans it parses only in part, macro values and display math are left alone.
 * Where two readings fit (W as a count or as Shapiro's bounded W), a reading
 * that leaves the span unchanged wins, then the first without a warning.
 */
export function reformatStatistics(text: string, o: ConvertOptions = {}): Reformatted {
  const style = o.style ?? APA7;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const [from, to] of inlineMathSpans(text)) {
    const original = text.slice(from, to);
    const inner = normaliseMath(original.slice(1, -1));
    let chosen: string | null = null, same = false;
    for (const pat of piecePatterns()) {
      const m = pat.re.exec(inner);
      if (!m) continue;
      const values: Record<string, string> = {};
      pat.labels.forEach((l, i) => { if (m[i + 1] !== undefined) values[l] = m[i + 1]; });
      const r = renderTemplate(pat.template, { style, greek: o.greek ?? 'italic', values, prune: true });
      if (r.text === original) { same = true; break; }
      if (chosen === null && !r.fields.some((f) => f.warning)) chosen = r.text;
    }
    if (!same && chosen !== null) changes.push({ from, to, insert: chosen });
  }
  let out = '', at = 0;
  for (const c of changes) { out += text.slice(at, c.from) + c.insert; at = c.to; }
  out += text.slice(at);
  return { text: out, count: changes.length, changes };
}
