import { describe, expect, it } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { at, inDoc } from '../../../editor/texContext/__tests__/helpers';
import { MAX_SOURCE_LINES, caretTarget, cleanSource, hoverTarget, katexInput, selectionTarget } from '../target';

/** The target under the character right after `¦`. */
const hover = (src: string) => {
  const { state, pos } = at(src);
  return hoverTarget(state, pos, 1);
};

describe('hoverTarget', () => {
  it('finds inline and display math with every delimiter, hovering on a delimiter too', () => {
    expect(hover(inDoc('Let $x^¦2$ hold.'))).toMatchObject({ source: 'x^2', display: false, kind: 'inline' });
    expect(hover(inDoc('Let ¦$x^2$ hold.')), 'on the opening $').toMatchObject({ source: 'x^2', display: false });
    expect(hover(inDoc('Let \\(a+¦b\\) hold.'))).toMatchObject({ source: 'a+b', display: false });
    expect(hover(inDoc('So \\[ \\frac{a}{¦b} \\] and'))).toMatchObject({ source: '\\frac{a}{b}', display: true, kind: 'display' });
    expect(hover(inDoc('So $$ E = m¦c^2 $$ and'))).toMatchObject({ source: 'E = mc^2', display: true });
  });

  it('spans the whole construct, so the preview stays open over all of it', () => {
    const src = inDoc('Let $x^¦2$ hold.');
    const { state, pos } = at(src);
    const t = hoverTarget(state, pos, 1)!;
    expect(state.sliceDoc(t.from, t.to)).toBe('$x^2$');
  });

  it('is nothing over text, after a formula from outside, or in an unclosed or escaped dollar', () => {
    expect(hover(inDoc('Plain ¦text here.'))).toBeNull();
    expect(hover(inDoc('Let $x$¦ hold.')), 'the space after the closing $').toBeNull();
    expect(hover(inDoc('Costs \\$¦5 and \\$6.'))).toBeNull();
    expect(hover(inDoc('An unclosed $x^¦2 here.'))).toBeNull();
  });

  it('is nothing in a comment or in verbatim text', () => {
    expect(hover(inDoc('% a comment with $x^¦2$ in it'))).toBeNull();
    expect(hover(inDoc('\\begin{verbatim}\n$x^¦2$\n\\end{verbatim}'))).toBeNull();
  });

  it('takes the outermost construct: a cases inside an equation previews the equation', () => {
    const t = hover(inDoc('\\begin{equation}\n f(x) = \\begin{cases} 1 & x>0 \\\\ 0 & \\text{else}¦ \\end{cases}\n\\end{equation}'));
    expect(t).toMatchObject({ kind: 'env', env: 'equation', display: true });
    expect(t!.source).toContain('\\begin{cases}');
  });

  it('previews a selection inside a formula on its own, in that formula\'s mode', () => {
    const src = inDoc('So \\[ a + \\frac{1}{2} + c \\] ok');
    const { state } = at(src);
    const from = src.indexOf('\\frac');
    const s = state.update({ selection: EditorSelection.range(from, from + '\\frac{1}{2}'.length) }).state;
    const t = hoverTarget(s, from + 2, 1);
    expect(t).toMatchObject({ kind: 'selection', source: '\\frac{1}{2}', display: true });
    expect(selectionTarget(s)?.source).toBe('\\frac{1}{2}');
  });

  it('marks a formula over the size limit as too long', () => {
    const rows = Array.from({ length: MAX_SOURCE_LINES + 5 }, (_, i) => `x_{${i}} &= ${i} \\\\`).join('\n');
    const t = hover(inDoc(`\\begin{align}\n¦${rows}\n\\end{align}`));
    expect(t?.tooLong).toBe(true);
    expect(hover(inDoc('Let $x^¦2$ hold.'))?.tooLong).toBe(false);
  });
});

describe('caretTarget', () => {
  it('is the formula the caret is in, or right after', () => {
    const { state, pos } = at(inDoc('Let $x^2¦$ hold.'));
    expect(caretTarget(state.update({ selection: EditorSelection.cursor(pos) }).state)?.source).toBe('x^2');
    const out = at(inDoc('Let $x^2$ ho¦ld.'));
    expect(caretTarget(out.state.update({ selection: EditorSelection.cursor(out.pos) }).state)).toBeNull();
  });
});

describe('katexInput', () => {
  const env = (name: string, source: string) => katexInput({ kind: 'env', env: name, display: name !== 'math', source });

  it('draws numbered displays starred, so no made-up equation number appears', () => {
    expect(env('equation', ' a = b ')).toEqual({ source: 'a = b', display: true });
    expect(env('equation*', 'a')).toEqual({ source: 'a', display: true });
    expect(env('align', 'a &= b')).toEqual({ source: '\\begin{align*}a &= b\\end{align*}', display: true });
    expect(env('gather*', 'a')).toEqual({ source: '\\begin{gather*}a\\end{gather*}', display: true });
    expect(env('alignat', '{2} a &= b')).toEqual({ source: '\\begin{alignat*}{2} a &= b\\end{alignat*}', display: true });
  });

  it('approximates what KaTeX lacks, and keeps the matrix family as written', () => {
    expect(env('multline', 'a \\\\ b').source).toBe('\\begin{gathered}a \\\\ b\\end{gathered}');
    expect(env('eqnarray', 'a &=& b').source).toBe('\\begin{aligned}a &=& b\\end{aligned}');
    expect(env('flalign*', 'a &= b').source).toBe('\\begin{aligned}a &= b\\end{aligned}');
    expect(env('pmatrix', '1 & 0').source).toBe('\\begin{pmatrix}1 & 0\\end{pmatrix}');
    expect(env('math', ' x ')).toEqual({ source: 'x', display: false });
  });

  it('leaves out labels, \\nonumber and \\notag', () => {
    expect(cleanSource('a \\label{eq:one} = b \\nonumber \\\\ c \\notag')).toBe('a  = b  \\\\ c ');
    expect(env('align', 'a \\label{x} &= b').source).toBe('\\begin{align*}a  &= b\\end{align*}');
  });
});
