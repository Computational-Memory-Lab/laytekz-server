import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { closeBrackets } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { autoEditCore } from '../../../editor/core/autoEdit';
import { keyChains } from '../../../editor/core/keyChains';
import { resetAutoEditNotices } from '../../../editor/core/notices';
import { headlessView, pressKey, typeText, withCaret, type HeadlessView } from '../../../editor/core/__tests__/replay';
import { autoMathFormatters } from '../api';
import { mathCompletionFilter, tabOutOfMath } from '../editor';
import { autoMathExtension, identifierRule, parseOperand, wrapRule, type AutoMathConfig } from '../rules';
import feature from '../index';
import { settings } from '../settings';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => store.values.get(id),
  setSetting: (id: string, v: unknown) => { store.values.set(id, v); },
}));

const latexLanguage = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

function editor(doc = '', o: { config?: Partial<AutoMathConfig>; extra?: Extension[]; brackets?: boolean } = {}): HeadlessView {
  const at = doc.indexOf('|');
  const text = at < 0 ? doc : doc.slice(0, at) + doc.slice(at + 1);
  return headlessView({
    doc: text,
    selection: EditorSelection.cursor(at < 0 ? text.length : at),
    extensions: [
      latexLanguage,
      ...(o.brackets ? [closeBrackets()] : []),
      autoEditCore([wrapRule, identifierRule]),
      autoMathExtension({ delimiter: 'auto', tabOut: true, ...o.config }),
      keyChains.of({ key: 'Tab', priority: 70, id: 'automath.tabOut', run: tabOutOfMath }),
      ...(o.extra ?? []),
    ],
  });
}

async function typed(text: string, doc = '', o: Parameters<typeof editor>[1] = {}): Promise<string> {
  const view = editor(doc, o);
  await typeText(view, text);
  return withCaret(view);
}

beforeEach(() => {
  store.values.clear();
  resetAutoEditNotices();
});

describe('automatic math mode: wrapping a math word when it ends', () => {
  it.each([
    ['where x_i is ', 'where $x_i$ is |'],
    ['so x^10 ', 'so $x^{10}$ |'],
    ['the x_max value', 'the $x_{max}$ value|'],
    ['as x^2, then', 'as $x^2$, then|'],
    ['about 10^6 cells', 'about $10^6$ cells|'],
    ['take lim_n ', 'take $\\lim_n$ |'],
    ['with \\alpha_1 ', 'with $\\alpha_1$ |'],
    ['of (a+b)^2.', 'of $(a+b)^2$.|'],
    ['so x^-1 ', 'so $x^{-1}$ |'],
    ['so x_2n ', 'so $x_{2n}$ |'],
  ])('T1: %j', async (input, out) => {
    expect(await typed(input)).toBe(out);
  });

  it.each([
    ['let \\alpha ', 'let $\\alpha$ |'],
    ['in \\mathbb{R}.', 'in $\\mathbb{R}$.|'],
    ['half is \\frac{1}{2},', 'half is $\\frac{1}{2}$,|'],
  ])('T2: %j', async (input, out) => {
    expect(await typed(input)).toBe(out);
  });

  it('T2 with closeBrackets stepping over its own closers', async () => {
    expect(await typed('in \\mathbb{R}.', '', { brackets: true })).toBe('in $\\mathbb{R}$.|');
  });

  it('T2: a macro the document defines as math', async () => {
    const doc = '\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\DeclareMathOperator{\\Var}{Var}\n\\begin{document}\n|\n\\end{document}';
    const view = editor(doc);
    await typeText(view, 'in \\R and \\Var ');
    expect(withCaret(view)).toContain('in $\\R$ and $\\Var$ |');
  });

  it.each([
    ['so p < .05, which', 'so $p < .05$, which|'],
    ['so p < 0.05, which', 'so $p < 0.05$, which|'],
    ['with n = 30 people', 'with $n = 30$ people|'],
    ['with n=30 people', 'with $n=30$ people|'],
    ['and p = .049.', 'and $p = .049$.|'],
    ['so x \\le 5,', 'so $x \\le 5$,|'],
    ['if x ≤ 5 ', 'if $x \\le 5$ |'],
    ['and x = y_2 ', 'and $x = y_2$ |'],
  ])('T3: %j', async (input, out) => {
    expect(await typed(input)).toBe(out);
  });

  it('T3 waits for the digits after a decimal point', async () => {
    const view = editor();
    await typeText(view, 'p < 0.');
    expect(withCaret(view)).toBe('p < 0.|');
    await typeText(view, '05,');
    expect(withCaret(view)).toBe('$p < 0.05$,|');
  });

  it.each([
    ['x_1 + y_2 ', '$x_1 + y_2$ |'],
    ['so x_i = 5,', 'so $x_i = 5$,|'],
    ['x_1 + y_2 = 3 ', '$x_1 + y_2 = 3$ |'],
  ])('T5 merges into the formula this run created: %j', async (input, out) => {
    expect(await typed(input)).toBe(out);
  });

  it('T5 does not merge across words or into a formula the person typed', async () => {
    expect(await typed('x_1 is a ')).toBe('$x_1$ is a |');
    expect(await typed(' + y ', '$x$|')).toBe('$x$ + y |');
  });

  it('wraps inside a closing bracket and at a table cell', async () => {
    expect(await typed('(see x_i)')).toBe('(see $x_i$)|');
    const doc = '\\begin{tabular}{ll}\n|\n\\end{tabular}';
    const view = editor(doc);
    await typeText(view, 'x_i & y');
    expect(withCaret(view)).toBe('\\begin{tabular}{ll}\n$x_i$ & y|\n\\end{tabular}');
  });

  it('uses \\( \\) when the file mostly does', async () => {
    expect(await typed('and x_i ', 'We have \\(a\\) and \\(b\\) and \\(c\\). |')).toBe('We have \\(a\\) and \\(b\\) and \\(c\\). and \\(x_i\\) |');
    expect(await typed('and x_i ', 'Plain text. |', { config: { delimiter: 'paren' } })).toBe('Plain text. and \\(x_i\\) |');
    expect(await typed('and x_i ', 'We have \\(a\\). |', { config: { delimiter: 'dollar' } })).toBe('We have \\(a\\). and $x_i$ |');
  });

  it.each([
    'e.g. this ', 'the t-test ', 'the x-axis ', 'a cat ', 'log files ', 'H. Smith ', 'COVID-19 ', 'I think ', 'n is ',
    'the 3 of us ', '5 + 3 ',
  ])('leaves prose alone: %j', async (input) => {
    expect(await typed(input)).toBe(`${input}|`);
  });

  it('never touches math, comments, literal arguments or code', async () => {
    expect(await typed(' x_i ', '$a + |$')).toBe('$a +  x_i |$');
    expect(await typed('% note x_i ')).toBe('% note x_i |');
    expect(await typed('\\cite{a_b} ', '', { brackets: true })).toBe('\\cite{a_b} |');
    expect(await typed('\\label{eq_1} ', '', { brackets: true })).toBe('\\label{eq_1} |');
    expect(await typed('\\foo_1 ')).toBe('\\foo_1 |');
    const preamble = '\\documentclass{article}\n|\n\\begin{document}\n\\end{document}';
    expect(await typed('\\newcommand{\\x}{x_i} ', preamble, { brackets: true })).toContain('\\newcommand{\\x}{x_i} |');
  });

  it('a relation on its own right after a word waits for its right-hand side', async () => {
    expect(await typed('so x \\le ')).toBe('so x \\le |');
    expect(await typed('the \\alpha ')).toBe('the $\\alpha$ |');
  });
});

describe('automatic math mode: underscores in names', () => {
  it.each([
    ['the my_var flag.', 'the my\\_var flag.|'],
    ['open results_final.csv now', 'open results\\_final.csv now|'],
    ['mail j_doe@x.com today', 'mail j\\_doe@x.com today|'],
    ['a snake_case_name here', 'a snake\\_case\\_name here|'],
    ['row 2_x ', 'row 2\\_x |'],
  ])('%j', async (input, out) => {
    expect(await typed(input)).toBe(out);
  });

  it('escapes \\texttt{x_1} instead of wrapping it, and leaves \\cite{a_b} literal', async () => {
    expect(await typed('\\texttt{x_1} ', '', { brackets: true })).toBe('\\texttt{x\\_1} |');
    expect(await typed('see \\cite{a_b}.', '', { brackets: true })).toBe('see \\cite{a_b}.|');
  });

  it('leaves an already escaped name alone', async () => {
    expect(await typed('my\\_var ')).toBe('my\\_var |');
  });
});

describe('automatic math mode: never fighting the person', () => {
  it('Backspace right after puts back what was typed, and that spot never fires again', async () => {
    const view = editor();
    await typeText(view, 'x_i ');
    expect(withCaret(view)).toBe('$x_i$ |');
    await pressKey(view, 'Backspace');
    expect(withCaret(view)).toBe('x_i |');
    await typeText(view, '= 5,');
    expect(withCaret(view)).toBe('x_i = 5,|');
    // A new word elsewhere still fires.
    await typeText(view, ' and y_j ');
    expect(withCaret(view)).toBe('x_i = 5, and $y_j$ |');
  });

  it('Backspace right after an escaped underscore leaves the raw one', async () => {
    const view = editor();
    await typeText(view, 'my_var ');
    expect(withCaret(view)).toBe('my\\_var |');
    await pressKey(view, 'Backspace');
    expect(withCaret(view)).toBe('my_var |');
  });

  it('each switch turns its rule off', async () => {
    store.values.set('automath.wrap', false);
    expect(await typed('where x_i is ')).toBe('where x_i is |');
    expect(await typed('the my_var flag ')).toBe('the my\\_var flag |');
    store.values.set('automath.wrap', true);
    store.values.set('automath.identifiers', false);
    expect(await typed('the my_var flag ')).toBe('the my_var flag |');
    expect(await typed('where x_i is ')).toBe('where $x_i$ is |');
  });

  it('edits that are not typing (a paste, a collaborator) never trigger it', async () => {
    const view = editor();
    view.dispatch({ changes: { from: 0, insert: 'x_i ' }, selection: { anchor: 4 }, userEvent: 'input.paste' });
    view.dispatch({ changes: { from: 4, insert: 'y_j ' } });
    await typeText(view, '');
    expect(view.state.doc.toString()).toBe('x_i y_j ');
  });
});

describe('Tab leaves inline math', () => {
  it('moves past the closer, and does nothing elsewhere or when off', async () => {
    let view = editor('$x_i|$ and');
    expect(await pressKey(view, 'Tab')).toBe(true);
    expect(withCaret(view)).toBe('$x_i$| and');
    view = editor('\\(a + b|\\) and');
    await pressKey(view, 'Tab');
    expect(withCaret(view)).toBe('\\(a + b\\)| and');
    view = editor('$x|+y$');
    expect(await pressKey(view, 'Tab')).toBe(false);
    view = editor('plain| text');
    expect(await pressKey(view, 'Tab')).toBe(false);
    view = editor('$x|$', { config: { tabOut: false } });
    expect(await pressKey(view, 'Tab')).toBe(false);
  });
});

describe('the completion filter', () => {
  const cx = (doc: string) => {
    const pos = doc.indexOf('|');
    const state = EditorState.create({ doc: doc.replace('|', ''), extensions: [latexLanguage] });
    return { state, pos } as unknown as CompletionContext;
  };
  const result: CompletionResult = { from: 0, options: [{ label: '\\cdot' }, { label: '\\cite' }, { label: '\\cdot' }, { label: '\\alpha', boost: 1 }] };

  it('lists each label once', () => {
    const out = mathCompletionFilter(result, cx('text \\c|'));
    expect(out.options.map((o) => o.label)).toEqual(['\\cdot', '\\cite', '\\alpha']);
    expect(out.options.find((o) => o.label === '\\cdot')?.boost).toBeUndefined();
  });

  it('ranks math commands first inside math', () => {
    const out = mathCompletionFilter(result, cx('$a \\c|$'));
    expect(out.options.find((o) => o.label === '\\cdot')?.boost).toBe(2);
    expect(out.options.find((o) => o.label === '\\alpha')?.boost).toBe(3);
    expect(out.options.find((o) => o.label === '\\cite')?.boost).toBeUndefined();
  });
});

describe('autoMathFormatters (public API for statistics)', () => {
  it('lets a formatter replace the plain wrap', async () => {
    const formatter = autoMathFormatters.of({
      id: 'test.stat',
      format: (i) => {
        const m = /t\((\d+)\) = (\d+\.\d+)$/.exec(i.text);
        return m && i.char === ',' ? { from: i.lineFrom + m.index, to: i.at, insert: `${i.open}t(${m[1]}) = ${m[2]}${i.close}` } : null;
      },
    });
    expect(await typed('with t(28) = 2.31, so', '', { extra: [formatter] })).toBe('with $t(28) = 2.31$, so|');
  });
});

describe('the module and its settings', () => {
  it('contributes both rules, Tab at the math Tab-out priority and the filter', () => {
    expect(feature.editor?.autoEditRules?.map((r) => r.id)).toEqual(['automath.wrap', 'automath.identifier']);
    expect(feature.editor?.keyChains?.[0]).toMatchObject({ key: 'Tab', priority: 70 });
    expect(feature.editor?.completionFilter).toBe(mathCompletionFilter);
  });

  it('registers an off switch for every automatic behaviour', () => {
    const ids = settings.map((s) => s.id);
    expect(ids).toEqual(['automath.wrap', 'automath.identifiers', 'automath.delimiter', 'automath.tabOut']);
    for (const s of settings.filter((d) => d.automatic)) expect(s.control.kind).toBe('switch');
    for (const s of settings) expect(s.validate(s.default)).toBe(true);
  });

  it('parses operands', () => {
    expect(parseOperand('x_max')).toEqual({ tex: 'x_{max}', bare: null });
    expect(parseOperand('my_var')).toBeNull();
    expect(parseOperand('\\cite{a_b}')).toBe('command');
    expect(parseOperand('.05')).toEqual({ tex: '.05', bare: 'number' });
  });
});
