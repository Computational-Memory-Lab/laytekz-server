import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closeBrackets } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { latexCloseBrackets } from '../../latexExtras';
import { contextAt } from '../../texContext';
import { autoEditCore, autoEditSettings } from '../autoEdit';
import type { AutoEditRule } from '../types';
import { replay } from './replay';

vi.mock('../../../settings/store', () => ({ getSetting: () => undefined, setSetting: () => {} }));

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** Real documents: the e2e demo paper and the bundled templates. */
const CORPUS: Record<string, string> = {
  'demo-paper': read('../../../../../../e2e/fixtures/demo-paper/main.tex'),
  article: read('../../../../../../templates/article/main.tex'),
  report: read('../../../../../../templates/report/main.tex'),
  beamer: read('../../../../../../templates/beamer/main.tex'),
};

/** A keystroke-by-keystroke replay of a few KB takes seconds on a loaded machine. */
const SLOW = 60_000;

const language = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

/** A stand-in for feature 1's rule: `&` typed in prose becomes `\&`, never after a backslash. */
const escapeAmp: AutoEditRule = {
  id: 'replay.amp',
  priority: 50,
  settingId: 'replay.amp',
  run(t) {
    if (t.char !== '&' || t.from !== t.to || t.before.sliceDoc(t.from - 1, t.from) === '\\') return null;
    return contextAt(t.before, t.from)?.kind === 'text' ? { rule: 'replay.amp', changes: { from: t.from, insert: '\\' } } : null;
  },
};

describe('the replay harness', () => {
  for (const [name, source] of Object.entries(CORPUS)) {
    it(`replays ${name} byte for byte with nothing automatic installed`, async () => {
      const r = await replay(source, [language, autoEditCore([])]);
      expect(r.divergences).toEqual([]);
      expect(r.identical).toBe(true);
      expect(r.keystrokes).toBe([...source].length);
      expect(r.autoEdits).toBe(0);
    }, SLOW);
  }

  it('keeps the text before the caret as typed with today’s bracket closing', async () => {
    const r = await replay(CORPUS['demo-paper'], [language, closeBrackets(), latexCloseBrackets('main.tex')]);
    expect(r.divergences).toEqual([]);
  }, SLOW);

  it('passes a typist who writes correct LaTeX with a rule on', async () => {
    const r = await replay(CORPUS['demo-paper'], [language, autoEditCore([escapeAmp]), autoEditSettings.of(() => true)]);
    expect(r.divergences).toEqual([]);
    expect(r.autoEdits).toBe(0);
    expect(r.identical).toBe(true);
  }, SLOW);

  it('reports the keystroke where a rule changed what was typed', async () => {
    const source = '\\begin{document}\nR&D and \\begin{tabular}{ll} a & b \\end{tabular}\n\\end{document}\n';
    const r = await replay(source, [language, autoEditCore([escapeAmp]), autoEditSettings.of(() => true)]);
    expect(r.autoEdits).toBe(1);
    expect(r.divergences).toEqual([{ keystroke: source.indexOf('&'), typed: '\\begin{document}\nR&', got: '\\begin{document}\nR\\&' }]);
    expect(r.doc).toBe(source.replace('R&D', 'R\\&D'));
    expect(r.identical).toBe(false);
  }, SLOW);
});
