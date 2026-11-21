import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, type Extension } from '@codemirror/state';
import { closeBrackets } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { latexCloseBrackets, applyCommand } from '../../../editor/latexExtras';
import { closerAt, closerField } from '../../../editor/core/brackets';
import { keyChains } from '../../../editor/core/keyChains';
import { autoEditCore } from '../../../editor/core/autoEdit';
import { headlessView, pressKey, typeText, withCaret, type HeadlessView } from '../../../editor/core/__tests__/replay';
import { NO_PAIRS, pairsExtension, type PairsConfig } from '../pairs';
import feature from '../index';
import { settings, PAIRS_SETTINGS } from '../settings';

vi.mock('../../../settings/store', () => ({ getSetting: () => undefined, setSetting: () => {}, subscribeSetting: () => () => {} }));

const ALL: PairsConfig = { brackets: true, math: true, quotes: true, tabOut: true };
const language = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

function editor(src = '', cfg: PairsConfig = ALL, extra: Extension[] = []): HeadlessView {
  const mark = src.indexOf('|');
  const doc = mark < 0 ? src : src.slice(0, mark) + src.slice(mark + 1);
  return headlessView({
    doc,
    selection: EditorSelection.cursor(mark < 0 ? doc.length : mark),
    extensions: [
      language,
      closeBrackets(),
      latexCloseBrackets('main.tex'),
      pairsExtension(cfg),
      ...(feature.editor!.keyChains ?? []).map((e) => keyChains.of(e)),
      ...extra,
    ],
  });
}

async function typed(text: string, cfg: PairsConfig = ALL, src = ''): Promise<string> {
  const v = editor(src, cfg);
  await typeText(v, text);
  return withCaret(v);
}

/** `\name` typed and completed as the list does (applyCommand), with `args` brace pairs. */
function complete(v: HeadlessView, name: string, args: number) {
  const head = v.state.selection.main.head;
  const line = v.state.doc.lineAt(head);
  const word = /\\[a-zA-Z]*$/.exec(v.state.sliceDoc(line.from, head))!;
  applyCommand(name, args, false)(v.asView(), { label: name }, head - word[0].length, head);
}

describe('dollar pairs', () => {
  it('pairs $ in text and types over the closer', async () => {
    expect(await typed('$')).toBe('$|$');
    expect(await typed('$x$')).toBe('$x$|');
    expect(await typed('see $a+b$ and')).toBe('see $a+b$ and|');
  });

  it('a second $ in an empty pair gives display math', async () => {
    expect(await typed('$$')).toBe('$$|$$');
    expect(await typed('$$x$$')).toBe('$$x$$|');
  });

  it('leaves \\$, a $ before a letter, and a $ in a comment alone', async () => {
    expect(await typed('\\$')).toBe('\\$|');
    expect(await typed('$', ALL, '|x')).toBe('$|x');
    expect(await typed('% $')).toBe('% $|');
  });

  it('does not pair a $ that closes an open formula', async () => {
    expect(await typed('$', ALL, '$x|')).toBe('$x$|');
  });

  it('Backspace empties a new pair, and $$¦$$ goes back to $¦$', async () => {
    const v = editor();
    await typeText(v, '$');
    await pressKey(v, 'Backspace');
    expect(withCaret(v)).toBe('|');
    await typeText(v, '$$');
    await pressKey(v, 'Backspace');
    expect(withCaret(v)).toBe('$|$');
  });

  it('$ wraps a selection', async () => {
    const v = editor('see x+y now');
    v.dispatch({ selection: EditorSelection.single(4, 7) });
    await typeText(v, '$');
    expect(v.state.doc.toString()).toBe('see $x+y$ now');
  });
});

describe('LaTeX delimiters', () => {
  it('\\( and \\[ get their closers, and typing the closer out steps over it', async () => {
    expect(await typed('\\(')).toBe('\\(|\\)');
    expect(await typed('\\(x\\)')).toBe('\\(x\\)|');
    expect(await typed('\\[')).toBe('\\[|\\]');
    expect(await typed('\\[x\\] done')).toBe('\\[x\\] done|');
  });

  it('a line break \\\\[ keeps the plain bracket pair', async () => {
    expect(await typed('a \\\\[')).toBe('a \\\\[|]');
  });

  it('Enter inside \\[¦\\] gives three lines', async () => {
    const v = editor();
    await typeText(v, '\\[');
    await pressKey(v, 'Enter');
    expect(withCaret(v)).toBe('\\[\n  |\n\\]');
  });

  it('Backspace inside \\(¦\\) leaves the backslash', async () => {
    const v = editor();
    await typeText(v, '\\(');
    await pressKey(v, 'Backspace');
    expect(withCaret(v)).toBe('\\|');
  });

  it('\\{ gets \\} in math and no closer in text', async () => {
    expect(await typed('$\\{')).toBe('$\\{|\\}$');
    expect(await typed('a \\{')).toBe('a \\{|');
  });

  it('\\left( gets \\right) in math, typed out without doubling', async () => {
    expect(await typed('$\\left(')).toBe('$\\left(|\\right)$');
    expect(await typed('$\\left( x \\right)')).toBe('$\\left( x \\right)|$');
    expect(await typed('$\\bigl[')).toBe('$\\bigl[|\\bigr]$');
    expect(await typed('$\\left.')).toBe('$\\left.|\\right.$');
    expect(await typed('$\\left\\{')).toBe('$\\left\\{|\\right\\}$');
  });

  it('Backspace right after \\left( removes the pair', async () => {
    const v = editor();
    await typeText(v, '$\\left(');
    await pressKey(v, 'Backspace');
    expect(withCaret(v)).toBe('$\\left|$');
  });

  it('outside math \\left( is a plain pair', async () => {
    expect(await typed('\\left(')).toBe('\\left(|)');
  });
});

describe('quotes', () => {
  it('` pairs with \' and `` with \'\'', async () => {
    expect(await typed('`')).toBe("`|'");
    expect(await typed('``')).toBe("``|''");
    expect(await typed("``quoted'' and")).toBe("``quoted'' and|");
    expect(await typed("`a' b")).toBe("`a' b|");
  });

  it('the grave accent and babel shorthands stay unpaired', async () => {
    expect(await typed('\\`e')).toBe('\\`e|');
    expect(await typed('"`x"\'')).toBe('"`x"\'|');
    expect(await typed("$f''(x)$")).toBe("$f''(x)$|");
  });
});

describe('brackets and completion braces', () => {
  it('closes { before $, punctuation and a backslash', async () => {
    expect(await typed('{', ALL, '|$')).toBe('{|}$');
    expect(await typed('(', ALL, '|.')).toBe('(|).');
    expect(await typed('[', ALL, '|\\alpha')).toBe('[|]\\alpha');
  });

  it('\\textb, the completion, then old} gives \\textbf{old}¦', async () => {
    const v = editor();
    await typeText(v, '\\textb');
    complete(v, '\\textbf', 1);
    expect(withCaret(v)).toBe('\\textbf{|}');
    await typeText(v, 'old}');
    expect(withCaret(v)).toBe('\\textbf{old}|');
  });

  it('Tab steps out of a completion brace, then of the next one', async () => {
    const v = editor();
    await typeText(v, '\\fra');
    complete(v, '\\frac', 2);
    await typeText(v, '1');
    expect(await pressKey(v, 'Tab')).toBe(true);
    expect(withCaret(v)).toBe('\\frac{1}|{}');
  });

  it('Tab steps out of a brace closeBrackets added', async () => {
    const v = editor();
    await typeText(v, '\\emph{x');
    expect(await pressKey(v, 'Tab')).toBe(true);
    expect(withCaret(v)).toBe('\\emph{x}|');
  });

  it('a closer is forgotten once the caret leaves its line', async () => {
    const v = editor('\\textbf{|}\nnext');
    v.dispatch({ effects: [], selection: { anchor: v.state.doc.length } });
    expect(v.state.field(closerField)).toEqual([]);
  });

  it('a change without an input event (a collaborator, undo) tracks nothing', () => {
    const v = editor();
    v.dispatch({ changes: { from: 0, insert: '\\textbf{}' }, selection: { anchor: 8 } });
    expect(closerAt(v.state, 8)).toBeNull();
  });
});

describe('switches', () => {
  const SAMPLES = ['$x$ and $$y$$', '\\(x\\)', '\\[x\\]', '$\\left( x \\right)$', "``q'' `a'", '$x^{2}$', '\\{a\\}'];

  it('every switch off types as Version 1 did', async () => {
    for (const s of SAMPLES) {
      const v1 = headlessView({ doc: '', extensions: [language, closeBrackets(), latexCloseBrackets('main.tex')] });
      await typeText(v1, s);
      expect(await typed(s, NO_PAIRS)).toBe(withCaret(v1));
    }
  });

  it('math off leaves $ unpaired; quotes off leaves ` unpaired; brackets off keeps V1 bracket closing', async () => {
    expect(await typed('$', { ...ALL, math: false })).toBe('$|');
    expect(await typed('`', { ...ALL, quotes: false })).toBe('`|');
    expect(await typed('{', { ...ALL, brackets: false }, '|$')).toBe('{|$');
  });

  it('brackets off: the completion brace is doubled as before', async () => {
    const v = editor('', { ...NO_PAIRS, math: true });
    await typeText(v, '\\textb');
    complete(v, '\\textbf', 1);
    await typeText(v, 'old}');
    expect(withCaret(v)).toBe('\\textbf{old}|}');
  });

  it('tabOut off: Tab is not taken', async () => {
    const v = editor('', { ...ALL, tabOut: false });
    await typeText(v, '\\emph{x');
    expect(await pressKey(v, 'Tab')).toBe(false);
  });

  it('every switch is an automatic switch under Typing, on by default', () => {
    expect(settings.map((s) => s.id).sort()).toEqual(Object.values(PAIRS_SETTINGS).sort());
    for (const s of settings) {
      expect(s.section).toBe('typing');
      expect(s.automatic).toBe(true);
      expect(s.default).toBe(true);
      expect(s.control.kind).toBe('switch');
    }
  });
});

describe('with the automatic-edit core', () => {
  it('runs in an editor with the currency rule installed', async () => {
    const v = editor('', ALL, [autoEditCore(feature.editor!.autoEditRules!)]);
    await typeText(v, 'costs $5 ');
    expect(withCaret(v)).toBe('costs \\$5 |');
  });
});
