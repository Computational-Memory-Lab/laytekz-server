import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState, Facet, type Extension, type StateEffect } from '@codemirror/state';
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import type { EditorFeatureCtx, EditorMode, FeatureModule } from '../../../features/types';
import type { AutoEditRule, KeyChainEntry, ModClickHandler } from '../types';
import type { PdfContextMenuEntry, PdfMenuTarget } from '../../../contextmenu/types';

const store = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  broken: false,
  subscribers: [] as Array<{ ids: string[]; fn: () => void }>,
}));

vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => {
    if (store.broken) throw new Error('Not implemented yet: settings/store getSetting');
    return store.values.get(id);
  },
  subscribeSetting: (ids: string | string[], fn: () => void) => {
    if (store.broken) throw new Error('Not implemented yet: settings/store subscribeSetting');
    const entry = { ids: [ids].flat(), fn };
    store.subscribers.push(entry);
    return () => { store.subscribers.splice(store.subscribers.indexOf(entry), 1); };
  },
}));

// The neighbours' runtime pieces: the facets stay real, the installers are spies.
vi.mock('../autoEdit', async (orig) => {
  const { Facet: F } = await import('@codemirror/state');
  const rulesSeen = F.define<readonly unknown[]>();
  return { ...(await orig<object>()), autoEditCore: vi.fn((rules: readonly unknown[]) => rulesSeen.of(rules)), rulesSeen };
});
vi.mock('../keyChains', async (orig) => ({ ...(await orig<object>()), keyChainsExtension: vi.fn(() => []) }));
vi.mock('../modClick', async (orig) => ({ ...(await orig<object>()), modClickExtension: vi.fn(() => []) }));
vi.mock('../../../contextmenu', () => ({ contextMenuExtension: vi.fn(() => []) }));
vi.mock('../../../keys/registry', () => ({ bindingFor: vi.fn(() => null) }));

import * as autoEdit from '../autoEdit';
import { keyChains, keyChainsExtension } from '../keyChains';
import { modClick, modClickExtension } from '../modClick';
import { contextMenuExtension } from '../../../contextmenu';
import { bindingFor } from '../../../keys/registry';
import {
  EditorFeatureHost, createEditorFeatureCtx, editorKeybindingHandler, mergeLineRects, pdfContextMenuItems, pdfMenuEntries,
  pointInRects, runsIn, toPdfRect,
} from '../featureHost';
import { CompletionSlot } from '../completion';

const rulesSeen = (autoEdit as unknown as { rulesSeen: Facet<readonly unknown[]> }).rulesSeen;
const probe = Facet.define<string>();

function makeCtx(mode: () => EditorMode, host?: Parameters<typeof createEditorFeatureCtx>[0]['host']): EditorFeatureCtx {
  return createEditorFeatureCtx({
    projectId: 'p', branch: 'main', filePath: 'main.tex', rootFile: 'main.tex',
    ydoc: {} as never, ytext: {} as never, awareness: {} as never, undoManager: {} as never,
    identity: () => ({ id: 'u1', name: 'Ada', color: '#123456' }),
    mode, readOnly: () => false, synced: () => true,
    host: host ?? (() => undefined),
  });
}

const rule = (id: string): AutoEditRule => ({ id, priority: 1, settingId: 'typing.explain', run: () => null });
const chain = (id: string): KeyChainEntry => ({ key: 'Tab', priority: 50, id, run: () => false });
const handler = (id: string): ModClickHandler => ({ id, priority: 1, target: () => null, run: () => {} });

function build(modules: FeatureModule[], o: { filePath?: string; mode?: EditorMode; completion?: CompletionSlot; warn?: (m: string, e?: unknown) => void } = {}) {
  let mode: EditorMode = o.mode ?? 'source';
  const ctx = makeCtx(() => mode);
  const host = new EditorFeatureHost({
    modules, ctx, filePath: o.filePath ?? 'main.tex', mode, completion: o.completion,
    page: () => null, runCommand: () => false, desktop: false, warn: o.warn ?? (() => {}),
  });
  let state = EditorState.create({ doc: 'Hello', extensions: [host.extension, host.input] });
  return {
    host,
    get state() { return state; },
    setMode(m: EditorMode) { mode = m; state = state.update({ effects: host.setMode(m) }).state; },
    apply(effects: StateEffect<unknown>[]) { state = state.update({ effects }).state; },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store.values.clear();
  store.broken = false;
  store.subscribers.length = 0;
  vi.mocked(autoEdit.autoEditCore).mockClear();
  vi.mocked(keyChainsExtension).mockClear();
  vi.mocked(contextMenuExtension).mockClear();
  vi.mocked(bindingFor).mockReset().mockReturnValue(null);
});

describe('feature compartments', () => {
  const escape: FeatureModule = {
    id: 'escape',
    editor: {
      extension: (ctx) => probe.of(`escape:${ctx.mode()}`),
      keyChains: [chain('escape.tab')],
      modClick: [handler('escape.link')],
      autoEditRules: [rule('escape.amp')],
    },
  };
  const automath: FeatureModule = { id: 'automath', editor: { modes: ['source'], extension: () => probe.of('automath'), autoEditRules: [rule('automath.wrap')] } };
  const bibOnly: FeatureModule = { id: 'references', editor: { files: /\.bib$/g, extension: () => probe.of('bib') } };
  const noEditor: FeatureModule = { id: 'pet' };

  it('installs each feature that runs in the file, with its key chains and mod-click handlers', () => {
    const t = build([escape, automath, bibOnly, noEditor]);
    expect(t.state.facet(probe)).toEqual(['escape:source', 'automath']);
    expect(t.state.facet(keyChains).map((e) => e.id)).toEqual(['escape.tab']);
    expect(t.state.facet(modClick).map((h) => h.id)).toEqual(['escape.link']);
    expect(t.host.runningIds()).toEqual(['escape', 'automath']);
    expect(build([bibOnly], { filePath: 'refs.bib' }).state.facet(probe)).toEqual(['bib']);
  });

  it('reconfigures on a mode change: a Source-only feature leaves Visual, the others are rebuilt for the mode', () => {
    const t = build([escape, automath]);
    t.setMode('visual');
    expect(t.state.facet(probe)).toEqual(['escape:visual']);
    expect(t.state.doc.toString()).toBe('Hello');
    t.setMode('source');
    expect(t.state.facet(probe)).toEqual(['escape:source', 'automath']);
  });

  it('gives autoEditCore the rules of the running features, again after a mode change, and none without rules', () => {
    const t = build([escape, automath]);
    expect(t.state.facet(rulesSeen)).toEqual([[escape.editor!.autoEditRules![0], automath.editor!.autoEditRules![0]]]);
    t.setMode('visual');
    expect(t.state.facet(rulesSeen)).toEqual([[escape.editor!.autoEditRules![0]]]);
    vi.mocked(autoEdit.autoEditCore).mockClear();
    build([bibOnly]);
    expect(autoEdit.autoEditCore).not.toHaveBeenCalled();
  });

  it('skips a feature that throws, with a warning, and keeps the others', () => {
    const warn = vi.fn();
    const source: CompletionSource = () => null;
    const broken: FeatureModule = { id: 'tables', editor: { extension: () => { throw new Error('boom'); }, keyChains: [chain('tables.tab')], completionSources: [() => source] } };
    const t = build([broken, escape], { warn });
    expect(t.state.facet(probe)).toEqual(['escape:source']);
    expect(t.state.facet(keyChains).map((e) => e.id)).toEqual(['escape.tab']);
    expect(t.host.runningIds()).toEqual(['escape']);
    expect(t.host.completionParts().sources).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tables'), expect.any(Error));
  });

  it('reconfigures only the feature whose deps changed, reading the setting through its context', () => {
    store.values.set('editor.wrap', true);
    let built = 0;
    const dep: FeatureModule = { id: 'links', editor: { deps: ['editor.wrap'], extension: (ctx) => { built++; return probe.of(`wrap:${ctx.setting<boolean>('editor.wrap')}`); } } };
    let escBuilt = 0;
    const other: FeatureModule = { id: 'escape', editor: { extension: () => { escBuilt++; return probe.of('escape'); } } };
    const t = build([dep, other]);
    expect(t.state.facet(probe)).toEqual(['wrap:true', 'escape']);
    const off = t.host.watch((effects) => t.apply(effects));
    expect(store.subscribers.map((s) => s.ids)).toEqual([['editor.wrap']]);
    store.values.set('editor.wrap', false);
    store.subscribers[0].fn();
    expect(t.state.facet(probe)).toEqual(['wrap:false', 'escape']);
    expect([built, escBuilt]).toEqual([2, 1]);
    off();
    expect(store.subscribers).toEqual([]);
  });

  it('falls back to a setting\'s default while the store cannot answer, and does not watch', () => {
    store.broken = true;
    const dep: FeatureModule = { id: 'links', editor: { deps: ['editor.wrap'], extension: (ctx) => probe.of(`wrap:${ctx.setting<boolean>('editor.wrap')}`) } };
    const t = build([dep]);
    expect(t.state.facet(probe)).toEqual(['wrap:true']);
    expect(() => t.host.watch(() => {})()).not.toThrow();
  });
});

describe('completion sources and filters', () => {
  const opt = (label: string): CompletionResult => ({ from: 0, options: [{ label }] });
  const core: CompletionSource = () => opt('core');
  const sourceA: CompletionSource = async () => opt('a');
  const tag = (t: string) => (r: CompletionResult) => ({ ...r, options: r.options.map((o) => ({ ...o, label: `${o.label}+${t}` })) });

  it('appends the features\' sources after the core ones and filters every result in manifest order', async () => {
    const slot = new CompletionSlot([core], 'typing');
    const a: FeatureModule = { id: 'escape', editor: { completionSources: [() => sourceA], completionFilter: tag('1') } };
    const b: FeatureModule = { id: 'automath', editor: { modes: ['source'], completionFilter: tag('2') } };
    const t = build([a, b], { completion: slot });
    const cx = new CompletionContext(t.state, 0, true);
    const labels = async () => Promise.all(slot.sources().map(async (s) => (await s(cx))?.options[0].label));
    expect(await labels()).toEqual(['core+1+2', 'a+1+2']);
    // Visual: b no longer runs, so its filter goes and the list is reconfigured.
    t.setMode('visual');
    expect(await labels()).toEqual(['core+1', 'a+1']);
  });

  it('keeps the list as it is when nothing about it changed', () => {
    const slot = new CompletionSlot([core], 'typing');
    const a: FeatureModule = { id: 'escape', editor: { extension: () => [] as Extension } };
    const t = build([a], { completion: slot });
    expect(slot.update({ parts: t.host.completionParts() })).toBeNull();
    expect(slot.update({ activation: 'typing' })).toBeNull();
    expect(slot.update({ activation: 'request' })).not.toBeNull();
  });
});

describe('the input core', () => {
  it('installs key chains and mod-click once, and the context menu only when a feature has entries', () => {
    const t = build([{ id: 'escape' }]);
    expect(t.host.keyChainsInstalled).toBe(true);
    expect(contextMenuExtension).not.toHaveBeenCalled();
    const entry = { id: 'probe.menu', group: 'annotate' as const, order: 1, items: () => null };
    build([{ id: 'highlighter', contextMenu: [entry] }, { id: 'escape' }]);
    expect(vi.mocked(contextMenuExtension).mock.calls[0][0]).toEqual([entry]);
    expect(keyChainsExtension).toHaveBeenCalledTimes(2);
    expect(modClickExtension).toHaveBeenCalled();
  });

  it('keeps V1\'s Tab keys when the key chains cannot start, and runs on without mod-click or a menu', () => {
    const warn = vi.fn();
    vi.mocked(keyChainsExtension).mockImplementationOnce(() => { throw new Error('Not implemented yet'); });
    vi.mocked(modClickExtension).mockImplementationOnce(() => { throw new Error('Not implemented yet'); });
    vi.mocked(contextMenuExtension).mockImplementationOnce(() => { throw new Error('Not implemented yet'); });
    const t = build([{ id: 'highlighter', contextMenu: [{ id: 'm', group: 'annotate', order: 1, items: () => null }] }], { warn });
    expect(t.host.keyChainsInstalled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('runs the command of the editor binding a key triggers', () => {
    const run = vi.fn(() => true);
    const keydown = editorKeybindingHandler(run, true);
    const e = { defaultPrevented: false, isComposing: false } as KeyboardEvent;
    expect(keydown(e)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    vi.mocked(bindingFor).mockReturnValue({ id: 'links.follow', label: 'Follow link', group: 'Links', default: null, changeable: true, scope: 'editor', command: 'links.follow' });
    expect(keydown(e)).toBe(true);
    expect(run).toHaveBeenCalledWith('links.follow');
    expect(vi.mocked(bindingFor).mock.calls[1]).toEqual([e, ['editor'], { desktop: true }]);
    expect(keydown({ ...e, isComposing: true } as KeyboardEvent)).toBe(false);
    expect(keydown({ ...e, defaultPrevented: true } as KeyboardEvent)).toBe(false);
  });

  it('leaves a core editor binding to the extension that defines it', () => {
    const run = vi.fn(() => true);
    vi.mocked(bindingFor).mockReturnValue({ id: 'follow', label: 'Follow', group: 'Editor', default: null, changeable: true, scope: 'editor', command: 'follow' });
    expect(editorKeybindingHandler(run, false)({ defaultPrevented: false, isComposing: false } as KeyboardEvent)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('turns the dispatch off, once, while the keybinding registry throws', () => {
    const warn = vi.fn();
    const keydown = editorKeybindingHandler(() => true, false, warn);
    vi.mocked(bindingFor).mockImplementation(() => { throw new Error('Not implemented yet'); });
    const e = { defaultPrevented: false, isComposing: false } as KeyboardEvent;
    expect(keydown(e)).toBe(false);
    expect(keydown(e)).toBe(false);
    expect(bindingFor).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('afterFormat', () => {
  function view(doc: string) {
    let state = EditorState.create({ doc });
    const events: string[] = [];
    return {
      get state() { return state; },
      dispatch(spec: { changes: unknown; userEvent: string }) { events.push(spec.userEvent); state = state.update(spec as never).state; },
      events,
    };
  }

  it('runs each running feature\'s afterFormat on the text the one before left, skipping one that throws', () => {
    const warn = vi.fn();
    const upper: FeatureModule = { id: 'tables', editor: { afterFormat: (s) => ({ from: 0, to: s.doc.length, insert: s.doc.toString().toUpperCase() }) } };
    const broken: FeatureModule = { id: 'stats', editor: { afterFormat: () => { throw new Error('boom'); } } };
    const bang: FeatureModule = { id: 'escape', editor: { afterFormat: (s) => ({ from: s.doc.length, insert: '!' }) } };
    const visualOnly: FeatureModule = { id: 'automath', editor: { modes: ['visual'], afterFormat: () => ({ from: 0, insert: 'x' }) } };
    const t = build([upper, broken, bang, visualOnly], { warn });
    expect(t.host.hasAfterFormat()).toBe(true);
    const v = view('abc');
    expect(t.host.runAfterFormat(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('ABC!');
    expect(v.events).toEqual(['input.format', 'input.format']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports no change when every feature leaves the text alone', () => {
    const t = build([{ id: 'tables', editor: { afterFormat: () => null } }]);
    const v = view('abc');
    expect(t.host.runAfterFormat(v)).toBe(false);
    expect(build([{ id: 'escape' }]).host.hasAfterFormat()).toBe(false);
  });
});

describe('the feature context', () => {
  it('reads settings from the store, routes to the page host, and follows the identity live', () => {
    store.values.set('editor.lineNumbers', false);
    const notify = vi.fn();
    const runCommand = vi.fn(() => true);
    const ctx = makeCtx(() => 'visual', () => ({ modules: [], page: () => null, userId: 'u1', notify, openSettings: vi.fn(), runCommand }));
    expect(ctx.setting('editor.lineNumbers')).toBe(false);
    expect(ctx.projectSetting('editor.lineNumbers')).toBe(false);
    store.values.set('editor.lineNumbers', 'junk');
    expect(ctx.setting('editor.lineNumbers')).toBe(true);
    ctx.notify('Done', 'ok');
    expect(notify).toHaveBeenCalledWith('Done', 'ok', undefined);
    expect(ctx.runCommand('x')).toBe(true);
    expect(ctx.mode()).toBe('visual');
    expect(ctx.identity).toEqual({ id: 'u1', name: 'Ada', color: '#123456' });
    expect(ctx.rootFile).toBe('main.tex');
  });

  it('does nothing without a page host', () => {
    const ctx = makeCtx(() => 'source');
    expect(ctx.runCommand('x')).toBe(false);
    expect(ctx.page()).toBeNull();
    expect(() => ctx.notify('x')).not.toThrow();
  });
});

describe('which files and modes a contribution runs in', () => {
  it('defaults to .tex and .ltx, and a /g pattern gives the same answer every time', () => {
    expect(runsIn({}, 'a/main.tex')).toBe(true);
    expect(runsIn({}, 'x.LTX')).toBe(true);
    expect(runsIn({}, 'refs.bib')).toBe(false);
    const c = { files: /\.bib$/g };
    expect([runsIn(c, 'refs.bib'), runsIn(c, 'refs.bib')]).toEqual([true, true]);
  });
});

describe('the PDF app menu', () => {
  const target: PdfMenuTarget = {
    page: 1, point: { x: 10, y: 20 }, event: {} as MouseEvent, pageCtx: null,
    selection: { page: 1, text: 'Some words', rects: [], pdfUrl: '/output/a.pdf' },
  };
  const entry = (id: string, group: PdfContextMenuEntry['group'], order: number, labels: string[] | null): PdfContextMenuEntry =>
    ({ id, group, order, items: () => labels && labels.map((label) => ({ id: label, label, onSelect: () => {} })) });

  it('orders the items by group and order, separates the groups and ends with Copy', () => {
    const copy = vi.fn();
    const items = pdfContextMenuItems([
      entry('nav', 'navigate', 1, ['Find in source']),
      entry('late', 'annotate', 20, ['Highlight']),
      entry('early', 'annotate', 10, ['Comment']),
      entry('none', 'copy', 1, null),
    ], target, copy)!;
    expect(items.map((i) => ('label' in i ? i.label : i.kind))).toEqual(['Comment', 'Highlight', 'separator', 'Find in source', 'separator', 'Copy']);
    const last = items[items.length - 1];
    if (last.kind === undefined || last.kind === 'item') { last.onSelect(); }
    expect(copy).toHaveBeenCalled();
    expect(last).toMatchObject({ testId: 'pdf-context-copy' });
  });

  it('is null, so the native menu shows, when no entry has an item here; an entry that throws is skipped', () => {
    const warn = vi.fn();
    const throws: PdfContextMenuEntry = { id: 'bad', group: 'annotate', order: 1, items: () => { throw new Error('boom'); } };
    expect(pdfContextMenuItems([entry('none', 'annotate', 1, []), throws], target, () => {}, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(pdfContextMenuItems([], target, () => {})).toBeNull();
  });

  it('collects the entries of every enabled module', () => {
    const a = entry('a', 'annotate', 1, null);
    expect(pdfMenuEntries([{ id: 'pdfComments', pdfContextMenu: [a] }, { id: 'escape' }])).toEqual([a]);
  });
});

describe('PDF selection geometry', () => {
  it('merges boxes on one line and keeps lines apart', () => {
    expect(mergeLineRects([
      { left: 50, top: 10, right: 80, bottom: 20 },
      { left: 10, top: 11, right: 45, bottom: 21 },
      { left: 10, top: 30, right: 60, bottom: 40 },
      { left: 0, top: 0, right: 0, bottom: 5 },
    ])).toEqual([
      { left: 10, top: 10, right: 80, bottom: 21 },
      { left: 10, top: 30, right: 60, bottom: 40 },
    ]);
  });

  it('tells a point inside a selection box, with some slop', () => {
    const boxes = [{ left: 100, top: 100, right: 200, bottom: 120 }];
    expect(pointInRects(boxes, 150, 110)).toBe(true);
    expect(pointInRects(boxes, 201, 121)).toBe(true);
    expect(pointInRects(boxes, 150, 130)).toBe(false);
  });

  it('turns client pixels into PDF points on the page, clamped to it', () => {
    expect(toPdfRect({ left: 120, top: 70, right: 220, bottom: 90 }, { left: 100, top: 50 }, 2, { width: 612, height: 792 }))
      .toEqual({ left: 10, top: 10, right: 60, bottom: 20 });
    expect(toPdfRect({ left: 90, top: 40, right: 5000, bottom: 5000 }, { left: 100, top: 50 }, 1, { width: 612, height: 792 }))
      .toEqual({ left: 0, top: 0, right: 612, bottom: 792 });
  });
});
