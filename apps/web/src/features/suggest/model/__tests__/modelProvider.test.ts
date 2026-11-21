import { describe, expect, it, vi } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { atWordBoundary, buildPrompt, createModelProvider, toSuggestion } from '../modelProvider';
import { MODEL } from '../manifest';
import { promptContext } from '../../promptContext';
import type { CompletionEngine } from '../engine';
import type { SuggestRequest } from '../../provider';

const doc = (s: string) => Text.of(s.split('\n'));

function request(src: string, o: { word?: string; explicit?: boolean } = {}): SuggestRequest {
  const pos = src.indexOf('|');
  const text = src.slice(0, pos) + src.slice(pos + 1);
  return { state: EditorState.create({ doc: text }), pos, word: o.word ?? '', explicit: o.explicit ?? false };
}

function engine(answer: string | ((prompt: string) => string)): CompletionEngine & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return typeof answer === 'function' ? answer(prompt) : answer;
    }),
    unload: vi.fn(async () => {}),
  };
}

describe('when the model is asked', () => {
  it('only at a word boundary: after a space or punctuation, before a line end, a space or a closer', () => {
    expect(atWordBoundary(doc('The results '), 12)).toBe(true);
    expect(atWordBoundary(doc('The results, then'), 12)).toBe(true);
    expect(atWordBoundary(doc('The results ). x'), 12)).toBe(true);
    expect(atWordBoundary(doc('The resul'), 9)).toBe(false);
    expect(atWordBoundary(doc('The results word'), 12)).toBe(false);
    expect(atWordBoundary(doc(''), 0)).toBe(false);
  });

  it('builds the fill-in-the-middle prompt without the trailing space', () => {
    const ctx = promptContext(doc('We measured the effect of '), 26);
    const p = buildPrompt(MODEL, ctx);
    expect(p.prompt).toBe('<|fim_prefix|>We measured the effect of<|fim_suffix|><|fim_middle|>');
    expect(p.spaceDropped).toBe(true);
    const ctx2 = promptContext(doc('A, b\nnext line'), 2);
    expect(buildPrompt(MODEL, ctx2)).toEqual({ prompt: '<|fim_prefix|>A,<|fim_suffix|> b\nnext line<|fim_middle|>', spaceDropped: false });
  });

  it('turns the raw continuation into a suggestion with the trimming rules', () => {
    const ctx = promptContext(doc('We measured the effect of '), 26);
    expect(toSuggestion(' temperature on growth. Then we', ctx, true)).toBe('temperature on growth.');
    expect(toSuggestion('temperature', ctx, true)).toBeNull(); // does not start a new word after the typed space
    expect(toSuggestion(' x<|end_of_text|>more', ctx, true)).toBeNull(); // under two characters
    expect(toSuggestion(' heat \\begin{table}', ctx, true)).toBe('heat');
  });
});

describe('the model provider', () => {
  const on = { enabled: () => true, visible: () => true };

  it('is deferred and answers with a trimmed suggestion at a word boundary', async () => {
    const e = engine(' the temperature on growth.\nNext');
    const p = createModelProvider({ ...on, runtime: async () => e });
    expect(p.deferred).toBe(true);
    const text = await p.suggest(request('\\begin{document}\nWe measured |'), new AbortController().signal);
    expect(text).toBe('the temperature on growth.');
    expect(e.prompts[0]).toBe('<|fim_prefix|>\nWe measured<|fim_suffix|><|fim_middle|>');
  });

  it('stays quiet when switched off, hidden, mid-word, or with no model', async () => {
    const e = engine(' more words here');
    const signal = new AbortController().signal;
    const runtime = vi.fn(async () => e);
    expect(await createModelProvider({ enabled: () => false, runtime }).suggest(request('Some text |'), signal)).toBeNull();
    expect(await createModelProvider({ enabled: () => true, visible: () => false, runtime }).suggest(request('Some text |'), signal)).toBeNull();
    expect(await createModelProvider({ ...on, runtime }).suggest(request('Some tex|', { word: 'tex' }), signal)).toBeNull();
    expect(await createModelProvider({ ...on, runtime }).suggest(request('|'), signal)).toBeNull();
    expect(runtime).not.toHaveBeenCalled();
    expect(await createModelProvider({ ...on, runtime: async () => null }).suggest(request('Some text |'), signal)).toBeNull();
    expect(await createModelProvider({ enabled: () => { throw new Error('store'); }, runtime }).suggest(request('Some text |'), signal)).toBeNull();
  });

  it('an explicit request may ask mid-word', async () => {
    const e = engine('t of the experiment');
    const p = createModelProvider({ ...on, runtime: async () => e });
    expect(await p.suggest(request('The resul|', { word: 'resul', explicit: true }), new AbortController().signal)).toBe('t of the experiment');
  });

  it('an aborted question shows nothing, and an engine failure is quiet', async () => {
    const abort = new AbortController();
    const slow: CompletionEngine = {
      complete: async () => {
        abort.abort();
        return ' late words here';
      },
      unload: async () => {},
    };
    expect(await createModelProvider({ ...on, runtime: async () => slow }).suggest(request('Some text |'), abort.signal)).toBeNull();
    const broken: CompletionEngine = { complete: async () => { throw new Error('kv cache full'); }, unload: async () => {} };
    expect(await createModelProvider({ ...on, runtime: async () => broken }).suggest(request('Some text |'), new AbortController().signal)).toBeNull();
  });
});
