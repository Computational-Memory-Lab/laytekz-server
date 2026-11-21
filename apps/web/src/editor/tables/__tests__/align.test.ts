import { describe, expect, it } from 'vitest';
import { alignTable, isAligned, realignIfWasAligned, whitespaceChanges } from '../align';
import type { AlignOptions, Change } from '../align';

function apply(src: string, changes: Change[]): string {
  let out = src;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

const aligned = (src: string, opts?: AlignOptions) => apply(src, alignTable(src, opts));

const EXAMPLE = [
  '\\begin{tabular}{lrc}',
  '\\toprule',
  'Model & Params & Acc. \\\\',
  '\\midrule',
  'Baseline&12M&71.2\\\\',
  '\\multicolumn{2}{l}{Ours} & 80.1 \\\\ % b',
  '\\bottomrule',
  '\\end{tabular}',
].join('\n');

/** Every table document in the table tests, plus the edge cases. */
const FIXTURES: string[] = [
  EXAMPLE,
  '\\begin{tabular}{ll}\n\\toprule\nH1 & H2 \\\\\n\\midrule\na & b \\\\\nc & d \\\\\n\\bottomrule\n\\end{tabular}',
  '\\begin{tabular}{|l|c|}\n\\hline\na & b \\\\\nc & d \\\\\n\\hline\n\\end{tabular}',
  '\\begin{tabular}{ll}\n  a & b \\\\\n    ccc & d \\\\\n\\end{tabular}',
  '\\begin{tabular}{lll}\nx & \\begin{tabular}{@{}c@{}}a\\\\b\\end{tabular} & q \\\\\nlonger & y & z \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\n\\verb|a&b| & c \\\\\nd & e \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\na & b \\tabularnewline\nccc & d \\tabularnewline\n\\end{tabular}',
  '\\begin{tabular}{ll}\na & b % note\n& c \\\\\nlong & d \\\\\n\n e & f \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\nR\\&D & {x & y} \\\\\nz & w \\\\[2pt] \\hline\nqq & \\\\* % n\n\\end{tabular}',
  '\\begin{tabular}{ll}\n\\hline a & b \\\\\n\\rowcolor{gray} cc & d \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\na & b \\\\ c & d \\\\\neee & f \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\n日 & a \\\\\nabcd & b \\\\\nq & é \\\\\n\\end{tabular}',
  '\\begin{tabular*}{\\textwidth}{@{}ll@{}}\na & b \\\\\nccc & d \\\\\n\\end{tabular*}',
  '\\begin{tabularx}{\\linewidth}{lX}\na & b \\\\\nccc & d \\\\\n\\end{tabularx}',
  '\\begin{tblr}{colspec={lr}}\na & 1 \\\\\nccc & 100 \\\\\n\\end{tblr}',
  '\\begin{longtable}{ll}\n\\caption{A long caption here}\\\\\nA & B \\\\\n\\endhead\nccc & d \\\\\n\\end{longtable}',
  '\\begin{align}\na &= b \\\\\nccc &= d + e\n\\end{align}',
  '\\begin{alignat}{2}\nx &= 1 && y &= 2 \\\\\nlong &= 3 && z &= 4\n\\end{alignat}',
  '\\begin{pmatrix}\n1 & 0 \\\\\n100 & 1\n\\end{pmatrix}',
  '\\begin{cases}\n1 & x > 0 \\\\\n-1 & \\text{otherwise}\n\\end{cases}',
  '\\begin{tabular}{@{}l@{}}a\\\\b\\end{tabular}',
  '\\begin{tabular}{lll}\na & b & c \\\\\n\\multicolumn{2}{c}{xy} & d \\\\\nlong & longer & e \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\na & b \\\\\nc\n\\end{tabular}',
  '\\begin{tabular}{lll}\n & b & \\\\\nccc &  & d \\\\\n\\end{tabular}',
];

const squash = (s: string) => s.replace(/\s+/g, '');
const lines = (s: string) => s.split('\n').length;

describe('aligning a table (F4)', () => {
  it('aligns the example exactly: padding by spec, the merged cell overflowing, the rules and comment left alone', () => {
    expect(aligned(EXAMPLE)).toBe([
      '\\begin{tabular}{lrc}',
      '\\toprule',
      'Model    & Params & Acc. \\\\',
      '\\midrule',
      'Baseline &    12M & 71.2 \\\\',
      '\\multicolumn{2}{l}{Ours} & 80.1 \\\\ % b',
      '\\bottomrule',
      '\\end{tabular}',
    ].join('\n'));
  });

  it('changes whitespace only, keeps every line, and is idempotent, over every fixture', () => {
    for (const src of FIXTURES) {
      for (const opts of [{}, { justify: 'left' as const }, { maxWidth: 0 }, { maxWidth: 3 }]) {
        const changes = alignTable(src, opts);
        for (const c of changes) {
          expect(src.slice(c.from, c.to)).toMatch(/^[ \t]*$/);
          expect(c.insert).toMatch(/^ *$/);
        }
        const out = apply(src, changes);
        expect(squash(out), src).toBe(squash(src));
        expect(lines(out), src).toBe(lines(src));
        expect(alignTable(out, opts), out).toEqual([]);
      }
    }
  });

  it('pads by the column spec, or always left when asked', () => {
    const src = '\\begin{tabular}{lrc}\na & 1 & x \\\\\nbb & 100 & long \\\\\n\\end{tabular}';
    expect(aligned(src)).toBe('\\begin{tabular}{lrc}\na  &   1 &  x   \\\\\nbb & 100 & long \\\\\n\\end{tabular}');
    expect(aligned(src, { justify: 'left' })).toBe('\\begin{tabular}{lrc}\na  & 1   & x    \\\\\nbb & 100 & long \\\\\n\\end{tabular}');
    // a centred first column does not change the table's indentation
    const c = '\\begin{tabular}{cc}\nx & y \\\\\nlong & z \\\\\n\\end{tabular}';
    expect(aligned(c)).toBe('\\begin{tabular}{cc}\n x   & y \\\\\nlong & z \\\\\n\\end{tabular}');
  });

  it('leaves rows with a comment, a line break or a blank line inside as written, without widening columns', () => {
    const src = '\\begin{tabular}{ll}\nvery long cell % x\n & b \\\\\na&b\\\\\ncc & d \\\\\n\\end{tabular}';
    expect(aligned(src)).toBe('\\begin{tabular}{ll}\nvery long cell % x\n & b \\\\\na  & b \\\\\ncc & d \\\\\n\\end{tabular}');
  });

  it('never splits \\&, a brace group, \\verb or a nested environment', () => {
    const src = '\\begin{ll}\n'; // not a table: nothing
    expect(alignTable(src)).toEqual([]);
    const verb = '\\begin{tabular}{ll}\n\\verb|a&b| & c \\\\\nd & e \\\\\n\\end{tabular}';
    expect(aligned(verb)).toBe('\\begin{tabular}{ll}\n\\verb|a&b| & c \\\\\nd          & e \\\\\n\\end{tabular}');
    const nested = '\\begin{tabular}{ll}\n{x & y} & \\begin{tabular}{c}a\\\\b\\end{tabular} \\\\\nR\\&D & e \\\\\n\\end{tabular}';
    expect(aligned(nested)).toBe('\\begin{tabular}{ll}\n{x & y} & \\begin{tabular}{c}a\\\\b\\end{tabular} \\\\\nR\\&D    & e                                   \\\\\n\\end{tabular}');
  });

  it('lets a merged cell fill the columns it spans when it fits, and overflow when it does not', () => {
    const fits = '\\begin{tabular}{lll}\naaaaaaaaaaaa & bbbbbbbbbbbb & c \\\\\n\\multicolumn{2}{c}{xy} & d \\\\\n\\end{tabular}';
    expect(aligned(fits)).toBe('\\begin{tabular}{lll}\naaaaaaaaaaaa & bbbbbbbbbbbb & c \\\\\n  \\multicolumn{2}{c}{xy}    & d \\\\\n\\end{tabular}');
    const over = '\\begin{tabular}{lll}\na & b & c \\\\\n\\multicolumn{2}{c}{xy}&d\\\\\nlong & x & e \\\\\n\\end{tabular}';
    expect(aligned(over)).toBe('\\begin{tabular}{lll}\na    & b & c \\\\\n\\multicolumn{2}{c}{xy} & d \\\\\nlong & x & e \\\\\n\\end{tabular}');
  });

  it('lets a cell wider than the limit overflow, and 0 means no limit', () => {
    const src = '\\begin{tabular}{ll}\na&b\\\\\naaaaaaaaaa & c \\\\\n\\end{tabular}';
    expect(aligned(src, { maxWidth: 5 })).toBe('\\begin{tabular}{ll}\na & b \\\\\naaaaaaaaaa & c \\\\\n\\end{tabular}');
    expect(aligned(src, { maxWidth: 0 })).toBe('\\begin{tabular}{ll}\na          & b \\\\\naaaaaaaaaa & c \\\\\n\\end{tabular}');
  });

  it('leaves rules, \\\\[2pt], \\\\* and what follows \\\\ on its line where they are', () => {
    const src = '\\begin{tabular}{ll}\n\\hline\na & b \\\\[2pt] \\hline\nccc&d\\\\* % n\n\\end{tabular}';
    expect(aligned(src)).toBe('\\begin{tabular}{ll}\n\\hline\na   & b \\\\[2pt] \\hline\nccc & d \\\\* % n\n\\end{tabular}');
  });

  it('aligns rows that start with a rule or \\rowcolor, and skips rows that share a line', () => {
    const src = '\\begin{tabular}{ll}\n\\hline a & b \\\\\n\\rowcolor{gray}cc & d \\\\\neee & f \\\\ g & h \\\\\n\\end{tabular}';
    expect(aligned(src)).toBe('\\begin{tabular}{ll}\n\\hline a   & b \\\\\n\\rowcolor{gray} cc  & d \\\\\neee & f \\\\ g & h \\\\\n\\end{tabular}');
  });

  it('never touches a table written on one line', () => {
    expect(alignTable('\\begin{tabular}{@{}l@{}}a\\\\b\\end{tabular}')).toEqual([]);
    expect(alignTable('\\begin{pmatrix}1&0\\\\10&1\\end{pmatrix}')).toEqual([]);
  });

  it('pads only before & in equation alignment, so &= and & \\quad stay as typed', () => {
    const src = '\\begin{align}\na &= b \\\\\nccc &= d + e\n\\end{align}';
    expect(aligned(src)).toBe('\\begin{align}\na   &= b     \\\\\nccc &= d + e\n\\end{align}');
    const q = '\\begin{align*}\nx & \\quad y \\\\\nlonger & z\n\\end{align*}';
    expect(aligned(q)).toBe('\\begin{align*}\nx      & \\quad y \\\\\nlonger & z\n\\end{align*}');
  });

  it('skips single-cell rows in a wider table (a longtable caption)', () => {
    const src = '\\begin{longtable}{ll}\n\\caption{A long caption here}\\\\\nA & B \\\\\nccc & d \\\\\n\\end{longtable}';
    expect(aligned(src)).toBe('\\begin{longtable}{ll}\n\\caption{A long caption here}\\\\\nA   & B \\\\\nccc & d \\\\\n\\end{longtable}');
  });

  it('never takes the arguments of tabular*, tabularx or tblr for cells, and pads tblr left', () => {
    expect(aligned('\\begin{tabular*}{\\textwidth}{@{}lr@{}}\na & 1 \\\\\nccc & 100 \\\\\n\\end{tabular*}'))
      .toBe('\\begin{tabular*}{\\textwidth}{@{}lr@{}}\na   &   1 \\\\\nccc & 100 \\\\\n\\end{tabular*}');
    expect(aligned('\\begin{tabularx}{\\linewidth}{lX}\na & b \\\\\nccc & d \\\\\n\\end{tabularx}'))
      .toBe('\\begin{tabularx}{\\linewidth}{lX}\na   & b \\\\\nccc & d \\\\\n\\end{tabularx}');
    expect(aligned('\\begin{tblr}{colspec={lr}}\na & 1 \\\\\nccc & 100 \\\\\n\\end{tblr}'))
      .toBe('\\begin{tblr}{colspec={lr}}\na   & 1   \\\\\nccc & 100 \\\\\n\\end{tblr}');
  });

  it('counts display columns: wide characters two, combining marks none', () => {
    expect(aligned('\\begin{tabular}{ll}\n日 & a \\\\\nabcd & b \\\\\n\\end{tabular}')).toBe('\\begin{tabular}{ll}\n日   & a \\\\\nabcd & b \\\\\n\\end{tabular}');
    expect(aligned('\\begin{tabular}{ll}\ne\u0301 & a \\\\\nab & b \\\\\n\\end{tabular}')).toBe('\\begin{tabular}{ll}\ne\u0301  & a \\\\\nab & b \\\\\n\\end{tabular}');
  });

  it('gives each row the table\'s indentation', () => {
    expect(aligned('\\begin{tabular}{ll}\n  a & b \\\\\n    ccc & d \\\\\n\\end{tabular}')).toBe('\\begin{tabular}{ll}\n  a   & b \\\\\n  ccc & d \\\\\n\\end{tabular}');
  });
});

describe('which tables count as aligned (keep-aligned)', () => {
  it('a padded, aligned table counts; a plain or unaligned one does not', () => {
    const plain = '\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}';
    expect(isAligned(plain)).toBe(false);
    const off = '\\begin{tabular}{ll}\na & b \\\\\nccc & d \\\\\n\\end{tabular}';
    expect(isAligned(off)).toBe(false);
    const done = aligned(off);
    expect(isAligned(done)).toBe(true);
    // edited after aligning: realigned only because it was aligned before
    const edited = done.replace('a   & b', 'abcde   & b');
    expect(apply(edited, realignIfWasAligned(done, edited))).toBe('\\begin{tabular}{ll}\nabcde & b \\\\\nccc   & d \\\\\n\\end{tabular}');
    expect(realignIfWasAligned(off, off.replace('a & b', 'abcde & b'))).toEqual([]);
  });
});

describe('whitespaceChanges', () => {
  it('replaces only the runs that differ, and refuses any other difference', () => {
    expect(whitespaceChanges('a&b', 'a & b', 10)).toEqual([{ from: 11, to: 11, insert: ' ' }, { from: 12, to: 12, insert: ' ' }]);
    expect(whitespaceChanges('a  & b', 'a & b', 0)).toEqual([{ from: 1, to: 3, insert: ' ' }]);
    expect(whitespaceChanges('a & b', 'a & c', 0)).toBeNull();
  });
});
