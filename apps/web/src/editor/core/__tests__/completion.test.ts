import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';

vi.mock('../../../api', () => ({ api: { bib: async () => [], labels: async () => [] } }));

import { CompletionSlot, completionExtension, coreCompletionSources, filteredSource } from '../completion';
import { keyCommandCompletionSource } from '../../latexExtras';
import { everydayCompletionSource } from '../../completions';

const cx = (doc = '\\sec', pos = doc.length) => new CompletionContext(EditorState.create({ doc }), pos, true);
const result = (label: string): CompletionResult => ({ from: 0, options: [{ label }] });
const suffix = (s: string) => (r: CompletionResult) => ({ ...r, options: r.options.map((o) => ({ ...o, label: o.label + s })) });

describe('the core completion sources', () => {
  it('are the V1 list, in V1\'s order', async () => {
    const sources = coreCompletionSources('p', 'main', () => 'main.tex');
    expect(sources).toHaveLength(7);
    expect(sources[1]).toBe(keyCommandCompletionSource);
    expect(sources[2]).toBe(everydayCompletionSource);
    // the package's command list, wrapped: \section is offered after \sec
    const first = await sources[0](cx());
    expect(first?.options.some((o) => o.label === '\\section' || o.label === 'section')).toBe(true);
  });
});

describe('filters', () => {
  it('apply in order to a source\'s results, sync or async, and leave an empty answer alone', async () => {
    const sync: CompletionSource = () => result('a');
    const later: CompletionSource = async () => result('b');
    const none: CompletionSource = () => null;
    const both = [suffix('1'), suffix('2')];
    expect((filteredSource(sync, both)(cx()) as CompletionResult).options[0].label).toBe('a12');
    expect((await filteredSource(later, both)(cx()))!.options[0].label).toBe('b12');
    expect(filteredSource(none, both)(cx())).toBeNull();
    expect(filteredSource(sync, [])).toBe(sync);
  });

  it('skip one that throws, and report it', () => {
    const warn = vi.fn();
    const throws = () => { throw new Error('boom'); };
    const r = filteredSource(() => result('a'), [throws, suffix('!')], warn)(cx()) as CompletionResult;
    expect(r.options[0].label).toBe('a!');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the "Show completions" setting', () => {
  it('leaves no completion list at all when off', () => {
    expect(completionExtension([() => null], 'off')).toEqual([]);
    expect(completionExtension([() => null], 'typing')).not.toEqual([]);
    expect(completionExtension([() => null], 'request')).not.toEqual([]);
  });

  it('reconfigures the list only when the setting or the feature parts change', () => {
    const core: CompletionSource = () => result('core');
    const extra: CompletionSource = () => result('extra');
    const slot = new CompletionSlot([core], 'typing');
    let state = EditorState.create({ extensions: slot.extension });
    expect(slot.update({ activation: 'typing' })).toBeNull();
    const effect = slot.update({ activation: 'off' });
    expect(effect).not.toBeNull();
    state = state.update({ effects: effect! }).state;
    expect(slot.update({ parts: { sources: [], filters: [] } })).toBeNull();
    expect(slot.update({ parts: { sources: [extra], filters: [] } })).not.toBeNull();
    expect(slot.sources().map((s) => (s(cx()) as CompletionResult).options[0].label)).toEqual(['core', 'extra']);
  });
});
