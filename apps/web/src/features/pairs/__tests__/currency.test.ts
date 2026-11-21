import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, type Extension } from '@codemirror/state';
import { closeBrackets } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { latexCloseBrackets } from '../../../editor/latexExtras';
import { autoEditCore, autoEditSettings, revertAutoEdit } from '../../../editor/core/autoEdit';
import { headlessView, typeText, withCaret, type HeadlessView } from '../../../editor/core/__tests__/replay';
import { NO_PAIRS, pairsExtension, type PairsConfig } from '../pairs';
import { currencyRule } from '../currency';

vi.mock('../../../settings/store', () => ({ getSetting: () => undefined, setSetting: () => {}, subscribeSetting: () => () => {} }));

const ALL: PairsConfig = { brackets: true, math: true, quotes: true, tabOut: true };
const language = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

function editor(cfg: PairsConfig, extra: Extension[] = [], doc = ''): HeadlessView {
  return headlessView({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [language, closeBrackets(), latexCloseBrackets('main.tex'), pairsExtension(cfg), autoEditCore([currencyRule]), ...extra],
  });
}

async function typed(text: string, cfg: PairsConfig = ALL, doc = ''): Promise<string> {
  const v = editor(cfg, [], doc);
  await typeText(v, text);
  return withCaret(v);
}

describe('the currency guard', () => {
  it('$5 and a space becomes \\$5, with the automatic closer gone', async () => {
    expect(await typed('$5 ')).toBe('\\$5 |');
    expect(await typed('it costs $1,200.50 a')).toBe('it costs \\$1,200.50 a|');
  });

  it('works without the dollar pairs too', async () => {
    expect(await typed('$5 ', NO_PAIRS)).toBe('\\$5 |');
    expect(await typed('$3k ', { ...ALL, math: false })).toBe('\\$3k |');
  });

  it('leaves formulas, escaped dollars and comments alone', async () => {
    expect(await typed('$x$ ')).toBe('$x$ |');
    expect(await typed('\\$5 ')).toBe('\\$5 |');
    expect(await typed('% $5 ', NO_PAIRS)).toBe('% $5 |');
    expect(await typed('$a+5 ')).toBe('$a+5 |$');
    expect(await typed('$$5 ')).toBe('$$5 |$$');
  });

  it('leaves a $ that closes a formula alone ($x$5 )', async () => {
    expect(await typed('$x$5 ', NO_PAIRS)).toBe('$x$5 |');
  });

  it('a space typed inside an existing formula $5|$ is left alone', async () => {
    const v = editor(ALL, [], '$5$');
    v.dispatch({ selection: { anchor: 2 } });
    await typeText(v, ' ');
    expect(withCaret(v)).toBe('$5 |$');
  });

  it('Backspace right after brings back what was typed', async () => {
    const v = editor(NO_PAIRS);
    await typeText(v, '$5 ');
    expect(revertAutoEdit(v.asView())).toBe(true);
    expect(withCaret(v)).toBe('$5 |');
  });

  it('the switch off turns it off', async () => {
    const v = editor(NO_PAIRS, [autoEditSettings.of((id) => id !== 'pairs.currency')]);
    await typeText(v, '$5 ');
    expect(withCaret(v)).toBe('$5 |');
  });
});
