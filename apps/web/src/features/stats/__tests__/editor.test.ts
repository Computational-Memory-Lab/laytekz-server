import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, type Extension } from '@codemirror/state';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { keyChains } from '../../../editor/core/keyChains';
import { statsEdit } from '../../../editor/core/autoEdit';
import { headlessView, pressKey, settle, typeText, withCaret, type HeadlessView } from '../../../editor/core/__tests__/replay';
import { entryByTrigger } from '../core/catalogue';
import { APA7, resolveStyle } from '../core/style';
import { DEFAULT_STATS_CONFIG, columnLetters, definedMacros, statsConfig, type StatsConfig } from '../config';
import { fieldsExtension, inStatField, sessionField } from '../fields';
import { insertAtSelection, insertStatistic, statsCompletionSource, triggerBefore } from '../insert';
import { convertPasted, offerText, pasteExtension } from '../paste';
import { formatTypedStatistic } from '../typed';
import feature from '../index';
import { settings } from '../settings';
import { getUi } from '../ui';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => store.values.get(id),
  setSetting: (id: string, v: unknown) => { store.values.set(id, v); },
  subscribeSetting: () => () => {},
}));

const latexLanguage = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

function editor(doc: string, cfg: Partial<StatsConfig> = {}, extra: Extension[] = []): HeadlessView {
  const at = doc.indexOf('|');
  const text = at < 0 ? doc : doc.slice(0, at) + doc.slice(at + 1);
  return headlessView({
    doc: text,
    selection: EditorSelection.cursor(at < 0 ? text.length : at),
    extensions: [
      latexLanguage,
      statsConfig.of({ ...DEFAULT_STATS_CONFIG, ...cfg }),
      fieldsExtension(),
      pasteExtension(),
      ...(feature.editor!.keyChains ?? []).map((e) => keyChains.of(e)),
      ...extra,
    ],
  });
}

const tab = (v: HeadlessView) => pressKey(v, 'Tab');

function complete(v: HeadlessView, explicit = false): CompletionResult | null {
  const cx = new CompletionContext(v.state, v.state.selection.main.head, explicit);
  return statsCompletionSource(cx) as CompletionResult | null;
}

beforeEach(() => { store.values.clear(); });

describe('triggers', () => {
  it('\\pv offers \\pval, ranked just below real commands that match as well', () => {
    const r = complete(editor('We found \\pv|'));
    expect(r?.options.map((o) => o.label)).toEqual(['\\pval']);
    expect(r?.options[0]).toMatchObject({ detail: 'p value · statistic', boost: -5 });
    expect(r?.from).toBe('We found '.length);
  });

  it('\\bayes offers the Bayes factor triggers', () => {
    const labels = complete(editor('so \\bayes|'))?.options.map((o) => o.label);
    expect(labels).toEqual(['\\bayes10', '\\bayes01', '\\bayesplus', '\\bayesttest']);
  });

  it('offers nothing after \\\\, in a comment, or with the setting off', () => {
    expect(complete(editor('a line\\\\pv|'))).toBeNull();
    expect(complete(editor('% see \\pv|'))).toBeNull();
    expect(complete(editor('We found \\pv|', { triggers: false }))).toBeNull();
  });

  it('hides a trigger the paper defines as a macro', () => {
    const v = editor('\\newcommand{\\pval}{0.05}\nWe found \\pv|');
    expect(complete(v)).toBeNull();
    expect(definedMacros('\\def\\ci{x} \\DeclareMathOperator{\\se}{se} \\newcommand\\msd{}')).toEqual(new Set(['ci', 'se', 'msd']));
  });

  it('Tab after a typed trigger expands it with the caret in the first field', async () => {
    const v = editor('We found \\pval|.');
    expect(triggerBefore(v.state, v.state.selection.main.head)?.entry.id).toBe('pval');
    expect(await tab(v)).toBe(true);
    expect(withCaret(v)).toBe('We found $p |$.');
    expect(v.state.field(sessionField)?.fields).toHaveLength(1);
    expect(inStatField(v.state, v.state.selection.main.head)).toBe(true);
    const insert = v.log[v.log.length - 1];
    expect(insert.annotation(statsEdit)).toBe(true);
  });

  it('Tab does nothing for an unknown command or a longer word', async () => {
    const v = editor('We found \\pvalue|');
    expect(await tab(v)).toBe(false);
    expect(triggerBefore(editor('\\pval|x').state, 5)).toBeNull();
  });
});

describe('fields', () => {
  it('\\pval, 0.0004, Tab stores $p < .001$ with the caret after it', async () => {
    const v = editor('We found \\pval|.');
    await tab(v);
    await typeText(v, '0.0004');
    expect(await tab(v)).toBe(true);
    expect(withCaret(v)).toBe('We found $p < .001$|.');
    expect(v.state.field(sessionField)).toBeNull();
  });

  it('a t test: Tab moves through df, t and p, formatting each', async () => {
    const v = editor('Result: |');
    insertStatistic(v.asView(), entryByTrigger('\\welch')!, { from: 8, to: 8 });
    await typeText(v, '17.776');
    await tab(v);
    await typeText(v, '-1.8608');
    await tab(v);
    await typeText(v, '0.07939');
    await tab(v);
    expect(withCaret(v)).toBe('Result: $t(17.78) = -1.86$, $p = .079$|');
  });

  it('Shift+Tab goes back and Enter finishes anywhere', async () => {
    const v = editor('|');
    insertStatistic(v.asView(), entryByTrigger('\\ttest')!, { from: 0, to: 0 });
    await typeText(v, '28');
    await tab(v);
    await typeText(v, '2.314');
    await pressKey(v, 'Shift-Tab');
    expect(v.state.field(sessionField)?.active).toBe(0);
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('28');
    expect(await pressKey(v, 'Enter')).toBe(true);
    expect(withCaret(v)).toBe('$t(28) = 2.31$, $p $|');
  });

  it('Escape stops the fields and keeps the text as typed', async () => {
    const v = editor('|');
    insertStatistic(v.asView(), entryByTrigger('\\pval')!, { from: 0, to: 0 });
    await typeText(v, '0.0004');
    expect(await pressKey(v, 'Escape')).toBe(true);
    expect(v.state.doc.toString()).toBe('$p 0.0004$');
    expect(v.state.field(sessionField)).toBeNull();
  });

  it('\\anova: an empty MSE part is removed at the finish', async () => {
    const v = editor('|');
    insertStatistic(v.asView(), entryByTrigger('\\anova')!, { from: 0, to: 0 });
    for (const value of ['2', '45', '3.215', '', '0.0471', '0.125']) {
      if (value) await typeText(v, value);
      await tab(v);
    }
    expect(withCaret(v)).toBe('$F(2, 45) = 3.22$, $p = .047$, $\\eta^2_{\\mathrm{p}} = .13$|');
  });

  it('the CI level is prefilled and selected, so typing replaces it', async () => {
    const v = editor('|');
    insertStatistic(v.asView(), entryByTrigger('\\ci')!, { from: 0, to: 0 });
    const sel = v.state.selection.main;
    expect(v.state.sliceDoc(sel.from, sel.to)).toBe('95');
    await typeText(v, '90');
    await tab(v);
    await typeText(v, '0.123');
    await tab(v);
    await typeText(v, '0.456');
    await tab(v);
    expect(withCaret(v)).toBe('90\\%~CI~$[0.12, 0.46]$|');
  });

  it('a value out of range is kept as typed', async () => {
    const v = editor('|');
    insertStatistic(v.asView(), entryByTrigger('\\pval')!, { from: 0, to: 0 });
    await typeText(v, '1.2');
    await tab(v);
    expect(v.state.doc.toString()).toBe('$p 1.2$');
  });

  it('formatting off keeps the fields but leaves the numbers', async () => {
    const v = editor('|', { formatOnLeave: false });
    insertStatistic(v.asView(), entryByTrigger('\\pval')!, { from: 0, to: 0 });
    await typeText(v, '0.0004');
    await tab(v);
    expect(v.state.doc.toString()).toBe('$p 0.0004$');
  });

  it('Leading zero "Always" gives 0.42', async () => {
    const v = editor('|', { style: resolveStyle({ leadingZero: 'always' }) });
    insertStatistic(v.asView(), entryByTrigger('\\etasq')!, { from: 0, to: 0 });
    await typeText(v, '.42');
    await tab(v);
    expect(v.state.doc.toString()).toBe('$\\eta^2 = 0.42$');
    const apa = editor('|', { style: APA7 });
    insertStatistic(apa.asView(), entryByTrigger('\\etasq')!, { from: 0, to: 0 });
    await typeText(apa, '0.42');
    await tab(apa);
    expect(apa.state.doc.toString()).toBe('$\\eta^2 = .42$');
  });

  it('inside math there are no dollar signs', async () => {
    const v = editor('\\[ \\pval| \\]');
    await tab(v);
    await typeText(v, '.0285');
    await tab(v);
    expect(withCaret(v)).toBe('\\[ p = .029| \\]');
  });

  it('a click elsewhere formats the field and ends the fields', async () => {
    const v = editor('Intro. |');
    insertStatistic(v.asView(), entryByTrigger('\\pval')!, { from: 7, to: 7 });
    await typeText(v, '0.0004');
    v.dispatch({ selection: { anchor: 2 }, userEvent: 'select.pointer' });
    await settle();
    expect(v.state.doc.toString()).toBe('Intro. $p < .001$');
    expect(v.state.field(sessionField)).toBeNull();
    expect(v.state.selection.main.head).toBe(2);
  });

  it("a collaborator's edit in a field is mapped; a local edit outside ends the fields", async () => {
    const v = editor('Intro. |');
    insertStatistic(v.asView(), entryByTrigger('\\pval')!, { from: 7, to: 7 });
    const field = v.state.field(sessionField)!.fields[0];
    v.dispatch({ changes: { from: field.from, insert: '0.5' } });
    expect(v.state.field(sessionField)!.fields[0]).toMatchObject({ from: field.from, to: field.from + 3 });
    v.dispatch({ changes: { from: 0, insert: 'X' } });
    expect(v.state.field(sessionField)).not.toBeNull();
    v.dispatch({ changes: { from: 0, insert: 'Y' }, userEvent: 'input.type' });
    expect(v.state.field(sessionField)).toBeNull();
  });

  it('a selected number fills the first value field (the picker)', () => {
    const v = editor('so 0.0004 here');
    v.dispatch({ selection: { anchor: 3, head: 9 } });
    insertAtSelection(v.asView(), entryByTrigger('\\pval')!);
    expect(withCaret(v)).toBe('so $p < .001$| here');
    expect(v.state.field(sessionField)).toBeNull();
  });
});

describe('paste and conversion', () => {
  const WELCH = [
    '\tWelch Two Sample t-test',
    '',
    'data:  extra by group',
    't = -1.8608, df = 17.776, p-value = 0.07939',
    'alternative hypothesis: true difference in means between group 1 and group 2 is not equal to 0',
    '95 percent confidence interval:',
    ' -3.3654832  0.2054832',
    'sample estimates:',
    'mean in group 1 mean in group 2 ',
    '           0.75            2.33 ',
  ].join('\n');

  it('a pasted R print is offered, and Convert rewrites it', () => {
    const v = editor('Results: |');
    v.dispatch(v.state.replaceSelection(WELCH), { userEvent: 'input.paste' });
    expect(offerText(v.state)).not.toBeNull();
    expect(getUi().offer).toBe(v.asView());
    expect(convertPasted(v.asView())).toBe(1);
    expect(v.state.doc.toString()).toBe('Results: $t(17.78) = -1.86$, $p = .079$, 95\\%~CI~$[-3.37, 0.21]$');
    expect(getUi().offer).toBeNull();
  });

  it('plain prose pasted gets no offer; the offer setting off shows none', () => {
    const v = editor('|');
    v.dispatch(v.state.replaceSelection('Just a sentence about nothing.'), { userEvent: 'input.paste' });
    expect(offerText(v.state)).toBeNull();
    const off = editor('|', { paste: false });
    off.dispatch(off.state.replaceSelection(WELCH), { userEvent: 'input.paste' });
    expect(getUi().offer).not.toBe(off.asView());
  });
});

describe('typed statistics (automatic math mode formatter)', () => {
  const input = (text: string, char: string, open = '$', close = '$') => {
    const v = editor(text);
    return formatTypedStatistic({ state: v.state, at: text.length, char, lineFrom: 0, text, open, close });
  };

  it('formats a typed p and t in the house style', () => {
    expect(input('we found p = 0.028', ',')).toEqual({ from: 9, to: 18, insert: '$p = .028$' });
    expect(input('so t(28) = 2.314', ' ')).toEqual({ from: 3, to: 16, insert: '$t(28) = 2.31$' });
    expect(input('so t(28) = 2.314', ' ', '\\(', '\\)')?.insert).toBe('\\(t(28) = 2.31\\)');
  });

  it('waits for the digits after a decimal point, and leaves other words alone', () => {
    expect(input('we found p = 0', '.')).toBeNull();
    expect(input('the model fits', ' ')).toBeNull();
  });

  it('does nothing with its setting off', () => {
    const state = editor('p = 0.028', { typed: false }).state;
    expect(formatTypedStatistic({ state, at: 9, char: ',', lineFrom: 0, text: 'p = 0.028', open: '$', close: '$' })).toBeNull();
  });
});

describe('helpers and settings', () => {
  it('reads the column letters of a tabular preamble', () => {
    expect(columnLetters('l S[table-format=1.3] |c')).toEqual(['l', 'S', 'c']);
    expect(columnLetters('*{2}{S} p{3cm} @{} r')).toEqual(['S', 'S', 'p', 'r']);
  });

  it('every automatic setting is a switch with a default of true', () => {
    for (const s of settings.filter((d) => d.automatic)) {
      expect(s.control.kind).toBe('switch');
      expect(s.default).toBe(true);
      expect(s.id.startsWith('stats.')).toBe(true);
    }
    expect(settings.find((s) => s.id === 'stats.style')?.scope).toBe('project');
  });

  it('declares Mod+Shift+U for Insert statistic', () => {
    expect(feature.keybindings?.[0]).toMatchObject({ id: 'stats.insert', command: 'stats.insert', scope: 'page', default: { mod: true, shift: true, key: 'u' } });
  });
});
