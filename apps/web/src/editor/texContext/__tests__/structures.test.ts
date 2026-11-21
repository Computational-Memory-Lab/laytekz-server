import { describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { commandAt, documentPackages, formulaAt, formulasIn, inlineMathStyle, tableEnvAt } from '..';
import { cellColumn, blankComments, argumentsEnd } from '../scan';
import { at, inDoc } from './helpers';

const formula = (src: string) => {
  const { state, pos } = at(src);
  return formulaAt(state, pos);
};

describe('formulaAt', () => {
  it('finds each kind of formula with its inner source', () => {
    expect(formula('a $x^¦2$ b')).toMatchObject({ from: 2, to: 7, innerFrom: 3, innerTo: 6, source: 'x^2', display: false, kind: 'inline' });
    expect(formula('a $$x¦$$ b')).toMatchObject({ from: 2, to: 7, innerFrom: 4, innerTo: 5, source: 'x', display: true, kind: 'display' });
    expect(formula('a \\(x¦\\) b')).toMatchObject({ source: 'x', display: false, kind: 'inline' });
    expect(formula('a \\[x¦\\] b')).toMatchObject({ source: 'x', display: true, kind: 'display' });
    expect(formula('\\begin{equation}E=mc^2¦\\end{equation}')).toMatchObject({ source: 'E=mc^2', display: true, kind: 'env', env: 'equation' });
    expect(formula('\\begin{align*}a&=b¦\\\\c&=d\\end{align*}')).toMatchObject({ source: 'a&=b\\\\c&=d', kind: 'env', env: 'align*' });
    expect(formula('\\begin{alignat}{2}a&¦=b\\end{alignat}')).toMatchObject({ source: 'a&=b', env: 'alignat' });
    expect(formula('\\begin{math}x¦\\end{math}')).toMatchObject({ display: false, kind: 'env', env: 'math' });
  });

  it('takes the outermost closed formula', () => {
    expect(formula('\\[ \\text{if $x¦$} \\]')).toMatchObject({ kind: 'display', from: 0 });
    expect(formula('$\\begin{pmatrix}a¦\\end{pmatrix}$')).toMatchObject({ kind: 'inline', from: 0 });
    expect(formula('\\begin{equation}\\begin{split}a¦\\end{split}\\end{equation}')).toMatchObject({ env: 'equation' });
  });

  it('skips what is not closed or not a formula', () => {
    expect(formula('a $x¦')).toBeNull();
    expect(formula('a ¦b')).toBeNull();
    expect(formula('\\begin{equation} x¦')).toBeNull();
    expect(formula('\\begin{tikzcd} A \\arrow[r] & B¦ \\end{tikzcd}')).toBeNull();
  });

  it('prefers a formula holding the position, then one ending there, then one starting there', () => {
    expect(formula('$a$¦$b$')).toMatchObject({ source: 'a' });
    expect(formula('x ¦$b$')).toMatchObject({ source: 'b' });
    expect(formula('$a$¦ x')).toMatchObject({ source: 'a' });
  });
});

describe('formulasIn', () => {
  it('lists the outermost formulas overlapping a range, in order', () => {
    const { state } = at('a $x$ b \\[ \\text{$y$} \\] c \\begin{equation}z\\end{equation} d $w');
    const found = formulasIn(state, 0, state.doc.length).map((f) => f.source.trim());
    expect(found).toEqual(['x', '\\text{$y$}', 'z']);
    expect(formulasIn(state, 0, 3).map((f) => f.source)).toEqual(['x']);
  });
});

describe('tableEnvAt', () => {
  it('gives name, family and body of the table around a position', () => {
    const src = 'x \\begin{tabular}{ll} a & b¦ \\\\ \\end{tabular} y';
    const { state, pos } = at(src);
    const t = tableEnvAt(state, pos)!;
    const doc = state.doc.toString();
    expect(t).toMatchObject({ name: 'tabular', family: 'tabular', from: 2 });
    expect(doc.slice(t.from, t.to)).toBe('\\begin{tabular}{ll} a & b \\\\ \\end{tabular}');
    expect(doc.slice(t.bodyFrom, t.bodyTo)).toBe(' a & b \\\\ ');
  });

  it('reads the arguments the vocabulary describes', () => {
    const { state, pos } = at('\\begin{tabular*}{\\textwidth}[t]{ll} a¦ \\end{tabular*}');
    const t = tableEnvAt(state, pos)!;
    expect(state.doc.sliceString(t.bodyFrom, t.bodyTo)).toBe(' a ');
    const m = at('$\\begin{pmatrix} a¦ \\end{pmatrix}$');
    expect(tableEnvAt(m.state, m.pos)).toMatchObject({ name: 'pmatrix', family: 'array' });
    const a = at('\\begin{alignat}{2} a &= b¦ \\end{alignat}');
    const ta = tableEnvAt(a.state, a.pos)!;
    expect(ta.family).toBe('align');
    expect(a.state.doc.sliceString(ta.bodyFrom, ta.bodyTo)).toBe(' a &= b ');
  });

  it('takes the innermost table, and none outside one', () => {
    const { state, pos } = at('\\begin{tabular}{l} \\begin{tabular}{c} x¦ \\end{tabular} \\end{tabular}');
    expect(tableEnvAt(state, pos)?.from).toBe(19);
    const out = at('a ¦b \\begin{tabular}{l} x \\end{tabular}');
    expect(tableEnvAt(out.state, out.pos)).toBeNull();
    const eq = at('\\begin{equation} x¦ \\end{equation}');
    expect(tableEnvAt(eq.state, eq.pos)).toBeNull();
  });
});

describe('commandAt', () => {
  it('finds the innermost command, its name without the backslash, and its arguments', () => {
    const { state, pos } = at('\\textbf{a \\emph{b¦}}');
    expect(commandAt(state, pos)).toEqual({ name: 'emph', from: 10, to: 18, args: [{ from: 16, to: 17, optional: false }] });
    const c = at('\\cite[see][p.~3]{k¦}');
    expect(commandAt(c.state, c.pos)).toEqual({
      name: 'cite', from: 0, to: 19,
      args: [{ from: 6, to: 9, optional: true }, { from: 11, to: 15, optional: true }, { from: 17, to: 18, optional: false }],
    });
  });

  it('keeps a star and finds the command from its name', () => {
    const { state, pos } = at('\\sect¦ion*{Intro}');
    expect(commandAt(state, pos)).toMatchObject({ name: 'section*', from: 0, args: [{ from: 10, to: 15, optional: false }] });
  });

  it('prefers a command holding the position over one touching it', () => {
    const inside = at('\\section{\\ref{x}¦ more}');
    expect(commandAt(inside.state, inside.pos)?.name).toBe('section');
    const after = at('see \\url{a}¦ b');
    expect(commandAt(after.state, after.pos)?.name).toBe('url');
    const none = at('plain ¦text');
    expect(commandAt(none.state, none.pos)).toBeNull();
  });
});

describe('inlineMathStyle', () => {
  const style = (s: string) => inlineMathStyle(Text.of(s.split('\n')));
  it('follows the delimiter the file uses more, with $ winning ties', () => {
    expect(style('$a$ and $b$ and \\(c\\)')).toBe('dollar');
    expect(style('\\(a\\) and \\(b\\) and $c$')).toBe('paren');
    expect(style('\\(a\\) and $b$')).toBe('dollar');
    expect(style('no math at all')).toBe('dollar');
  });
  it('ignores display math, escaped dollars and comments', () => {
    expect(style('\\(a\\) $$b$$ \\$5 and \\$6')).toBe('paren');
    expect(style('\\(a\\)\n% $x$ $y$ $z$ $w$')).toBe('paren');
  });
});

describe('documentPackages', () => {
  it('lists the packages the preamble loads', () => {
    const state = EditorState.create({ doc: '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath, graphicx}\n\\RequirePackage{xcolor}\n% \\usepackage{hidden}\n\\begin{document}\n\\usepackage{late}\n\\end{document}' });
    expect([...documentPackages(state)].sort()).toEqual(['amsmath', 'graphicx', 'inputenc', 'xcolor']);
  });
  it('reads a file without a document environment whole', () => {
    expect([...documentPackages(EditorState.create({ doc: '\\usepackage{a}' }))]).toEqual(['a']);
  });
});

describe('scans', () => {
  it('counts the top-level cells of a row', () => {
    const doc = Text.of(['a & {b & c} & \\verb|&| & \\begin{minipage}{1cm}x&y\\end{minipage} & % &', '& z \\\\ next & ']);
    expect(cellColumn(doc, 0, doc.length)).toBe(1);
    expect(cellColumn(doc, 0, doc.line(1).length)).toBe(4);
  });
  it('blanks comments without moving offsets', () => {
    expect(blankComments('a % b\nc \\% d % e')).toBe('a    \nc \\% d    ');
  });
  it('reads table arguments, and gives up on an unclosed one', () => {
    const doc = Text.of(['{\\textwidth} [t] {l{c}r} body']);
    expect(argumentsEnd(doc, 0, '{[{')).toBe(24);
    expect(argumentsEnd(doc, 0, '{[[{')).toBe(24);
    expect(argumentsEnd(Text.of(['{ll']), 0, '{')).toBeNull();
  });
  it('needs no tree for any of them', () => {
    expect(inDoc('x')).toContain('\\begin{document}');
  });
});
