import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { autoEditCore } from '../autoEdit';
import { autoEditNotices, NOTICE_COUNTS_KEY, NOTICE_LIMIT, resetAutoEditNotices, showAutoEditNotice, type NoticeSink } from '../notices';
import type { AutoEditRule } from '../types';
import { headlessView, pressKey, typeText } from './replay';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>(), set: [] as [string, unknown][] }));
vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => store.values.get(id),
  setSetting: (id: string, v: unknown) => { store.set.push([id, v]); store.values.set(id, v); },
}));
vi.mock('../../../settings/registry', () => ({
  settingDef: (id: string) => (id === 'test.amp' ? { id, label: 'Escape & as you type' } : undefined),
}));

/** localStorage for the counts (vitest runs without a DOM). */
const local = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../util/safeStorage', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../util/safeStorage')>();
  const storage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => { local.set(k, v); },
    removeItem: (k: string) => { local.delete(k); },
  } as unknown as Storage;
  return { ...real, safeStorage: real.makeSafeStore(() => storage) };
});

const amp: AutoEditRule = {
  id: 'test.amp',
  priority: 50,
  settingId: 'test.amp',
  run: (t) => (t.char === '&' && t.before.sliceDoc(t.from - 1, t.from) !== '\\'
    ? { rule: 'test.amp', changes: { from: t.from, insert: '\\' }, notice: { kind: 'escape.amp', text: 'Typed & became \\&. Backspace undoes it.', settingId: 'test.amp' } }
    : null),
};

function editor(sink: NoticeSink | null) {
  return headlessView({ doc: '', selection: EditorSelection.cursor(0), extensions: [autoEditCore([amp]), sink ? autoEditNotices.of(sink) : []] });
}

beforeEach(() => {
  store.values.clear();
  store.set.length = 0;
  local.clear();
  resetAutoEditNotices();
});

describe('automatic-edit notices', () => {
  it('explain each kind at most three times, with a Turn off action', async () => {
    const sink = vi.fn<NoticeSink>();
    const view = editor(sink);
    await typeText(view, '& & & & ');
    expect(view.state.doc.toString()).toBe('\\& \\& \\& \\& ');
    expect(sink).toHaveBeenCalledTimes(NOTICE_LIMIT);
    expect(sink).toHaveBeenCalledWith('Typed & became \\&. Backspace undoes it.', 'info', expect.objectContaining({ label: 'Turn off' }));
    expect(JSON.parse(local.get(NOTICE_COUNTS_KEY)!)).toEqual({ 'escape.amp': 3 });
    sink.mock.calls[0][2]!.run();
    expect(store.set).toEqual([['test.amp', false]]);
    await typeText(view, '&');
    expect(view.state.doc.toString()).toBe('\\& \\& \\& \\& &');
  });

  it('stay silent while explanations are off, or without a sink', async () => {
    store.values.set('typing.explain', false);
    const sink = vi.fn<NoticeSink>();
    await typeText(editor(sink), '&');
    expect(sink).not.toHaveBeenCalled();
    store.values.clear();
    const view = editor(null);
    await typeText(view, '&');
    expect(showAutoEditNotice(view.state, { kind: 'k', text: 't', settingId: 's' })).toBe(false);
    expect(local.size).toBe(0);
  });

  it('offer to turn a rule off after it was reverted twice in this tab', async () => {
    const sink = vi.fn<NoticeSink>();
    const view = editor(sink);
    local.set(NOTICE_COUNTS_KEY, JSON.stringify({ 'escape.amp': 3 }));
    await typeText(view, 'a&');
    await pressKey(view, 'Backspace');
    await typeText(view, ' b&');
    await pressKey(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('a& b&');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('You reverted this change twice. Turn off “Escape & as you type”?', 'info', expect.objectContaining({ label: 'Turn off' }));
    await typeText(view, ' c&');
    await pressKey(view, 'Backspace');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('survive storage that holds junk', async () => {
    local.set(NOTICE_COUNTS_KEY, '{"escape.amp":"many"}');
    const sink = vi.fn<NoticeSink>();
    await typeText(editor(sink), '&');
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
