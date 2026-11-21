import type { AutoMathFormatter, AutoMathFormatterInput, AutoMathFormatterResult } from '../automath/api';
import { recognise, renderPieces } from './core/parse';
import { greekFor, statsConfig } from './config';

/**
 * Statistics typed in prose (feature 16 with automatic math mode): when a
 * word ends after `t(28) = 2.31` or `p = 0.028`, automatic math mode asks this
 * formatter first, so the statistic gets the house style (`$t(28) = 2.31$`,
 * `$p = .028$`) instead of a plain `$…$`. Pure: it reads only the state.
 */

/** `$…$` pairs written with the file's own delimiters. */
function delimit(text: string, open: string, close: string): string {
  if (open === '$' && close === '$') return text;
  let inside = false;
  return text.replace(/(?<!\\)\$/g, () => { inside = !inside; return inside ? open : close; });
}

export function formatTypedStatistic(i: AutoMathFormatterInput): AutoMathFormatterResult | null {
  const cfg = i.state.facet(statsConfig);
  if (!cfg.typed) return null;
  // A decimal point or a thousands comma right after digits is not the end of the number yet.
  if (i.char === '.' && /(?:^|[^\d.])\d+$/.test(i.text)) return null;
  if (i.char === ',' && /(?:^|[^\d.,])\d{1,3}$/.test(i.text)) return null;
  const blocks = recognise(i.text);
  const b = blocks[blocks.length - 1];
  if (!b || b.source !== 'text' || b.to !== i.text.length) return null;
  const r = renderPieces(b.pieces, { style: cfg.style, greek: greekFor(i.state, cfg.style) });
  if (r.fields.some((f) => f.from === f.to || f.warning)) return null;
  return { from: i.lineFrom + b.from, to: i.lineFrom + b.to, insert: delimit(r.text, i.open, i.close) };
}

export const typedStatisticFormatter: AutoMathFormatter = { id: 'stats.typed', format: formatTypedStatistic };
