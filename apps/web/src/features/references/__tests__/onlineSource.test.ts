import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { headlessView } from '../../../editor/core/__tests__/replay';
import { citeQueryAt, MIN_QUERY, onlineCiteSource, searchLabel } from '../onlineSource';
import { settings, REFERENCES_SETTING } from '../settings';

const at = (line: string) => citeQueryAt(line, line.length);

describe('citeQueryAt', () => {
  it('finds the key being typed inside every citation command', () => {
    expect(at('see \\cite{vasw')).toEqual({ from: 10, query: 'vasw' });
    expect(at('\\parencite[see][12]{lamp')).toMatchObject({ query: 'lamp' });
    expect(at('\\citep*{a, b,  knu')).toEqual({ from: 15, query: 'knu' });
    expect(at('\\textcite{x2020,')).toBeNull();
  });
  it('ignores text outside a citation and a finished argument', () => {
    expect(at('plain text vasw')).toBeNull();
    expect(at('\\ref{fig')).toBeNull();
    expect(at('\\cite{done} more')).toBeNull();
    expect(at('\\cite{vasw ')).toBeNull();
  });
});

function complete(doc: string, enabled = true) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) });
  const open = vi.fn();
  const source = onlineCiteSource({ enabled: () => enabled, open });
  const result = source(new CompletionContext(state, doc.length, false)) as CompletionResult | null;
  return { result, open, state };
}

describe('"Search online for …" in citation completion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers one last item once three characters are typed, and asks nothing of the network', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = complete('As in \\cite{attention');
    expect(result?.options).toHaveLength(1);
    expect(result?.options[0].label).toBe(searchLabel('attention'));
    expect(result?.options[0].boost).toBe(-99);
    expect(result?.from).toBe('As in \\cite{'.length);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('is not offered below three characters, outside citations, or with the setting off', () => {
    expect(MIN_QUERY).toBe(3);
    expect(complete('\\cite{at').result).toBeNull();
    expect(complete('attention').result).toBeNull();
    expect(complete('\\cite{attention', false).result).toBeNull();
  });

  it('choosing it removes the half-typed key and opens the panel with it', () => {
    const doc = 'As in \\cite{attention}.';
    const pos = doc.indexOf('}');
    const v = headlessView({ doc, selection: EditorSelection.cursor(pos) });
    const open = vi.fn();
    const source = onlineCiteSource({ enabled: () => true, open });
    const result = source(new CompletionContext(v.state, pos, true)) as CompletionResult;
    const option = result.options[0];
    (option.apply as (view: unknown, c: unknown, from: number, to: number) => void)(v.asView(), option, result.from, pos);
    expect(v.state.doc.toString()).toBe('As in \\cite{}.');
    expect(open).toHaveBeenCalledWith('attention');
  });
});

describe('references settings', () => {
  it('defines the per-person switches and the project settings WP16 reads', () => {
    const byId = new Map(settings.map((s) => [s.id, s]));
    for (const id of Object.values(REFERENCES_SETTING)) expect(byId.has(id)).toBe(true);
    expect(byId.get(REFERENCES_SETTING.preview)?.default).toBe(true);
    expect(byId.get(REFERENCES_SETTING.keyStyle)?.scope).toBe('project');
    for (const s of settings) {
      expect(s.section).toBe('references');
      expect(s.validate(s.default)).toBe(true);
    }
    const bib = byId.get(REFERENCES_SETTING.defaultBib)!;
    expect(bib.validate('refs/extra.bib')).toBe(true);
    expect(bib.validate('notes.txt')).toBe(false);
  });
});
