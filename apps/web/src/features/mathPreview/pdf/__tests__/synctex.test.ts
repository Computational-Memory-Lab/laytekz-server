import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { displayRect, parseSynctex, tagFor, type SynctexRect } from '../synctex';
import { synctexLines } from '../compiled';
import { gunzipText } from '../gunzip';
import { rootDirOf } from '../loader';

/**
 * The fixtures were typeset with pdfLaTeX (TeX Live 2026) from display.tex,
 * chapters/ch1.tex and single.tex beside them, in the compiler's layout
 * (`-output-directory=.aldine-out ./main.tex`), with uncompressed SyncTeX.
 * EXPECTED is the union of the boxes `synctex view -i <closing line>:0:<file>`
 * reported for each formula on the same build (h, v − H, h + W, v), which the
 * parser must match within 0.5 bp.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const display = parseSynctex(fixture('display.synctex'));
const single = parseSynctex(fixture('single.synctex'));

const EXPECTED: { what: string; file: string; lines: [number, number]; rect: [number, number, number, number]; data: 'display' | 'single' }[] = [
  { what: '\\[ … \\] over three lines', file: 'main.tex', lines: [7, 9], rect: [275.324066, 169.158929, 334.927456, 180.920715], data: 'display' },
  { what: 'a numbered equation, with its number', file: 'main.tex', lines: [11, 13], rect: [242.503967, 217.383978, 484.453277, 244.106247], data: 'display' },
  { what: 'a two-row align, both rows and their numbers', file: 'main.tex', lines: [15, 18], rect: [125.798241, 278.660871, 484.45327, 308.748016], data: 'display' },
  { what: 'an equation holding a pmatrix, after a blank line', file: 'main.tex', lines: [20, 22], rect: [273.500519, 330.187618, 484.453278, 357.28598], data: 'display' },
  { what: 'equation* in an \\input chapter', file: 'chapters/ch1.tex', lines: [2, 4], rect: [264.673981, 387.622185, 345.577591, 420.225037], data: 'display' },
  { what: '\\[ … \\] on one line after a paragraph', file: 'single.tex', lines: [5, 5], rect: [290.29541, 150.067208, 320.952387, 159.505173], data: 'single' },
  { what: 'a numbered equation on one line', file: 'single.tex', lines: [7, 7], rect: [286.253876, 179.955117, 477.479447, 191.053528], data: 'single' },
];

function rectFor(data: 'display' | 'single', file: string, [a, b]: [number, number]): SynctexRect | null {
  const d = data === 'display' ? display : single;
  const tag = tagFor(d.inputs, file, '');
  if (tag === null) return null;
  const lines = synctexLines({ firstLine: a, lastLine: b, textBefore: false, textAfter: false });
  return lines ? displayRect(d, tag, lines.first, lines.last, { single: lines.single }) : null;
}

describe('SyncTeX parser', () => {
  it('reads the inputs and maps them to project paths', () => {
    expect(display.inputs.size).toBe(12);
    expect(tagFor(display.inputs, 'main.tex', '')).toBe(1);
    expect(tagFor(display.inputs, 'chapters/ch1.tex', '')).toBe(11);
    expect(tagFor(display.inputs, 'nothere.tex', '')).toBeNull();
    // a root in a folder: the inputs are relative to it
    const nested = new Map([[1, '/srv/data/p/paper/./main.tex'], [2, '/srv/data/p/paper/./chapters/../intro.tex'], [3, 'sec/x.tex'], [4, '/abs/other/shared.tex']]);
    expect(tagFor(nested, 'paper/main.tex', 'paper')).toBe(1);
    expect(tagFor(nested, 'paper/intro.tex', 'paper')).toBe(2);
    expect(tagFor(nested, 'paper/sec/x.tex', 'paper')).toBe(3);
    expect(tagFor(nested, 'other/shared.tex', 'paper')).toBe(4);
    expect(tagFor(nested, 'main.tex', 'paper')).toBeNull();
  });

  for (const e of EXPECTED) {
    it(`crops ${e.what} within 0.5 bp of synctex view`, () => {
      const r = rectFor(e.data, e.file, e.lines);
      expect(r).not.toBeNull();
      expect(r!.page).toBe(1);
      expect(r!.continues).toBe(false);
      const got = [r!.x0, r!.y0, r!.x1, r!.y1];
      got.forEach((v, i) => expect(Math.abs(v - e.rect[i])).toBeLessThan(0.5));
    });
  }

  it('pads the crop', () => {
    const r = displayRect(display, 1, 8, 9, { pad: 3 })!;
    expect(r.x0).toBeCloseTo(275.324066 - 3, 2);
    expect(r.y1).toBeCloseTo(180.920715 + 3, 2);
  });

  it('gives null when in doubt', () => {
    expect(displayRect(display, 99, 8, 9)).toBeNull(); // no such input
    expect(displayRect(display, 1, 1, 3)).toBeNull(); // the preamble typesets nothing
    // the align's rows span the whole line, as a paragraph line does: on one line they cannot be told apart
    expect(displayRect(display, 1, 18, 18, { single: true })).toBeNull();
    // a single-line range that holds the paragraph before the display as well
    expect(synctexLines({ firstLine: 5, lastLine: 5, textBefore: true, textAfter: false })).toBeNull();
    // text after the closing line of an environment whose records all sit on it
    expect(synctexLines({ firstLine: 11, lastLine: 12, textBefore: false, textAfter: true })).toBeNull();
  });

  it('refuses text that is not SyncTeX', () => {
    expect(() => parseSynctex('<html>')).toThrow();
  });

  it('gunzips what the server sends, and finds the root folder', async () => {
    const text = fixture('display.synctex');
    expect(await gunzipText(gzipSync(text))).toBe(text);
    await expect(gunzipText(gzipSync(text), 100)).rejects.toThrow();
    expect(rootDirOf('.aldine-out/main.synctex.gz')).toBe('');
    expect(rootDirOf('paper/.aldine-out/main.synctex.gz')).toBe('paper');
    expect(rootDirOf('paper/main.synctex.gz')).toBeNull();
  });
});
