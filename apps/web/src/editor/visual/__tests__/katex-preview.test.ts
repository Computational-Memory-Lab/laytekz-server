import { describe, expect, it } from 'vitest';
import { UPRIGHT_ALIASES, katexLoaded, mathError, renderMath } from '../katex';
import { preambleMacros } from '../preamble';
import { issueText, unknownCommands } from '../../../features/mathPreview/render';

describe('KaTeX for the formula preview (WP13)', () => {
  it('loads, and says why a formula cannot be parsed, with where', async () => {
    expect(await katexLoaded()).toBe(true);
    expect(mathError('x^2 + \\frac{a}{b}', false)).toBeNull();
    const err = mathError('\\frac{a}{b', false)!;
    expect(err.message).toMatch(/expected '}'/i);
    expect(err.message).not.toMatch(/^KaTeX parse error/);
    expect(typeof err.position === 'number' || err.position === null).toBe(true);
  });

  it('uses the preamble\'s macros, and draws the upright aliases instead of naming them', async () => {
    await katexLoaded();
    const macros = preambleMacros('\\newcommand{\\R}{\\mathbb{R}}');
    const html = renderMath('x \\in \\R', false, macros)!;
    expect(unknownCommands(html)).toEqual([]);
    expect(UPRIGHT_ALIASES['\\upbeta']).toBe('\\beta');
    expect(unknownCommands(renderMath('\\upbeta + \\symup{d}x', false)!)).toEqual([]);
  });

  it('names commands nothing defines, in plain words', async () => {
    await katexLoaded();
    const html = renderMath('\\foo + x', false)!;
    expect(unknownCommands(html)).toEqual(['\\foo']);
    expect(issueText(html)).toMatch(/^Can't draw \\foo: not defined in the preamble/);
  });
});
