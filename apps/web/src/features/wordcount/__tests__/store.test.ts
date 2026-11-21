import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countDocument, DEFAULT_RULE } from '../../../wordcount/engine';
import type { EditorPageCtx } from '../../types';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('../../../api', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../../../settings/store', () => ({ getSetting: () => true, subscribeSetting: () => () => {} }));

const { createEmitter } = await import('../../events');
const { __resetWordCount, reportLive, watchWordCount, wordCountSnapshot } = await import('../store');

const FILES: Record<string, string> = {
  'main.tex': '\\documentclass{article}\n\\begin{document}\nRoot words here.\n\\input{ch}\n\\end{document}\n',
  'ch.tex': 'Chapter words.\n',
};

function answer() {
  const doc = countDocument('main.tex', (p) => FILES[p] ?? null);
  return { ...doc, rule: DEFAULT_RULE, ruleSource: 'default', ruleName: 'Main text', citeWords: {}, worksCited: 0, otherDocuments: [], unreachable: [] };
}

function page(file: string): EditorPageCtx {
  return { projectId: 'p1', branch: 'main', events: createEmitter(), activeFile: () => file, peers: () => [] } as unknown as EditorPageCtx;
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => { __resetWordCount(); apiRequest.mockReset(); apiRequest.mockImplementation(async () => answer()); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the word count store', () => {
  it('fetches the breakdown, keeps the open file live, and counts the selection', async () => {
    const p = page('ch.tex');
    const stop = watchWordCount(p);
    expect(apiRequest).toHaveBeenCalledWith('/api/projects/p1/wordcount/breakdown?branch=main');
    await flush();
    expect(wordCountSnapshot().total).toBe(5);
    expect(wordCountSnapshot().inDoc).toBe(true);
    reportLive('p1', 'main', 'ch.tex', FILES['ch.tex'], null);
    reportLive('p1', 'main', 'ch.tex', 'Chapter words and more.\n', 'and more');
    expect(wordCountSnapshot().total).toBe(7);
    expect(wordCountSnapshot().sel).toBe(2);
    vi.advanceTimersByTime(5000);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    stop();
  });

  it('refetches once after an edit to a file that includes others, then rests', async () => {
    const p = page('main.tex');
    const stop = watchWordCount(p);
    await flush();
    reportLive('p1', 'main', 'main.tex', FILES['main.tex'], null);
    wordCountSnapshot();
    vi.advanceTimersByTime(2000);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    reportLive('p1', 'main', 'main.tex', FILES['main.tex'].replace('here.', 'here now.'), null);
    wordCountSnapshot();
    vi.advanceTimersByTime(1000);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    await flush();
    wordCountSnapshot();
    vi.advanceTimersByTime(5000);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    stop();
  });

  it('asks again when files change, and stops when the page closes', async () => {
    const p = page('main.tex');
    const stop = watchWordCount(p);
    await flush();
    p.events.emit('filesChanged', {});
    vi.advanceTimersByTime(300);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    p.events.emit('projectSettingsChanged', { ids: ['other.setting'] });
    vi.advanceTimersByTime(300);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    p.events.emit('projectSettingsChanged', { ids: ['wordcount.rule'] });
    vi.advanceTimersByTime(300);
    expect(apiRequest).toHaveBeenCalledTimes(3);
    stop();
    p.events.emit('filesChanged', {});
    vi.advanceTimersByTime(1000);
    expect(apiRequest).toHaveBeenCalledTimes(3);
    expect(wordCountSnapshot().breakdown).toBeNull();
  });
});
