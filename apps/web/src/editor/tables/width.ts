/**
 * How many monospace columns text takes on screen: one per grapheme cluster,
 * two for East Asian wide and fullwidth characters and for emoji, none for a
 * cluster that is only combining marks. So `é` counts 1 composed or not,
 * `日本語` 6, and a skin-toned or ZWJ emoji 2.
 */

const segmenter: { segment(s: string): Iterable<{ segment: string }> } | null = (() => {
  try {
    const S = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    return S ? new S(undefined, { granularity: 'grapheme' }) : null;
  } catch {
    return null;
  }
})();

const COMBINING = /^\p{M}+$/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** East Asian Wide (W) and Fullwidth (F) code points, as Unicode's EastAsianWidth.txt ranges them. */
function wide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xa960 && cp <= 0xa97f)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe19)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd);
}

function clusterWidth(g: string): number {
  if (COMBINING.test(g)) return 0;
  const cp = g.codePointAt(0) ?? 0;
  if (cp < 0x7f) return cp < 0x20 ? 0 : 1;
  if (EMOJI.test(g) && (g.length > 1 || cp >= 0x1f000)) return 2;
  return wide(cp) ? 2 : 1;
}

/** The display width of `text` (one line) in monospace columns. */
export function displayWidth(text: string): number {
  // the common case: plain ASCII
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let w = 0;
  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) w += clusterWidth(segment);
    return w;
  }
  for (const ch of text) w += COMBINING.test(ch) ? 0 : clusterWidth(ch);
  return w;
}
