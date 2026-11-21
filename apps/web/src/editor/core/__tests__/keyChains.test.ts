import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Prec, type Transaction, type TransactionSpec } from '@codemirror/state';
import { keymap, type EditorView, type KeyBinding } from '@codemirror/view';
import { acceptCompletion, closeCompletion } from '@codemirror/autocomplete';
import { indentLess, indentMore, indentWithTab } from '@codemirror/commands';
import { CHAIN_KEYS, CORE_CHAIN, chainFor, keyChains, keyChainsExtension, runChain } from '../keyChains';
import { KEY_CHAIN_PRIORITY, type KeyChainEntry } from '../types';

/** Enough of an EditorView for commands that read the state and dispatch. */
function fakeView(state: EditorState): EditorView & { state: EditorState } {
  const v = {
    state,
    dispatch(...specs: (Transaction | TransactionSpec)[]) {
      const s = specs[0];
      v.state = ('startState' in (s as object) ? (s as Transaction) : v.state.update(s as TransactionSpec)).state;
    },
  };
  return v as unknown as EditorView & { state: EditorState };
}

const entry = (key: KeyChainEntry['key'], priority: number, id: string, handled: boolean, log: string[]): KeyChainEntry =>
  ({ key, priority, id, run: () => { log.push(id); return handled; } });

describe('the core links (moved unchanged from CodePane)', () => {
  it('are acceptCompletion at 100 then indentMore at 0 for Tab, indentLess for Shift-Tab, closeCompletion for Escape', () => {
    const state = EditorState.create({ extensions: keyChainsExtension() });
    expect(chainFor(state, 'Tab').map((e) => [e.priority, e.run])).toEqual([[100, acceptCompletion], [0, indentMore]]);
    expect(chainFor(state, 'Shift-Tab').map((e) => e.run)).toEqual([indentLess]);
    expect(chainFor(state, 'Escape').map((e) => [e.priority, e.run])).toEqual([[KEY_CHAIN_PRIORITY.Escape.completion, closeCompletion]]);
    // the same commands indentWithTab bound before
    expect([indentWithTab.run, indentWithTab.shift]).toEqual([indentMore, indentLess]);
    expect(CORE_CHAIN).toHaveLength(4);
  });

  it('indent the line on Tab when no completion list is open (and during its 75 ms interaction delay)', () => {
    const view = fakeView(EditorState.create({ doc: 'Row a & b\n', selection: EditorSelection.cursor(3), extensions: keyChainsExtension() }));
    expect(runChain(view, 'Tab')).toBe(true);
    expect(view.state.doc.toString()).toBe('  Row a & b\n');
    expect(runChain(view, 'Shift-Tab')).toBe(true);
    expect(view.state.doc.toString()).toBe('Row a & b\n');
  });

  it('leave Escape alone when no list is open, so Vim and the panels still get it', () => {
    const view = fakeView(EditorState.create({ doc: 'x', extensions: keyChainsExtension() }));
    expect(runChain(view, 'Escape')).toBe(false);
    expect(runChain(view, 'Enter'), 'no Enter links in the core').toBe(false);
  });

  it('change nothing in a read-only document: Tab falls through to the browser', () => {
    const view = fakeView(EditorState.create({ doc: 'x', extensions: [keyChainsExtension(), EditorState.readOnly.of(true)] }));
    expect(runChain(view, 'Tab')).toBe(false);
    expect(view.state.doc.toString()).toBe('x');
  });
});

describe('running a chain', () => {
  it('runs a key\'s entries from the highest priority down and stops at the first that handles it', () => {
    const log: string[] = [];
    const state = EditorState.create({
      extensions: [
        keyChains.of(entry('Tab', 60, 'table', true, log)),
        keyChains.of(entry('Tab', 80, 'suggestion', false, log)),
        keyChains.of(entry('Tab', 90, 'fields', false, log)),
        keyChains.of(entry('Escape', 95, 'esc', true, log)),
        keyChains.of(entry('Tab', 10, 'late', true, log)),
      ],
    });
    expect(runChain(fakeView(state), 'Tab')).toBe(true);
    expect(log).toEqual(['fields', 'suggestion', 'table']);
  });

  it('slots features between the core links by priority', () => {
    const log: string[] = [];
    const tabOut = entry('Tab', KEY_CHAIN_PRIORITY.Tab.mathTabOut, 'mathTabOut', false, log);
    const state = EditorState.create({ extensions: [keyChainsExtension(), keyChains.of(tabOut)] });
    expect(chainFor(state, 'Tab').map((e) => e.id)).toEqual(['core.acceptCompletion', 'mathTabOut', 'core.indent']);
  });

  it('keeps facet order between equal priorities, and higher precedence first', () => {
    const log: string[] = [];
    const state = EditorState.create({
      extensions: [keyChains.of(entry('Enter', 90, 'a', false, log)), keyChains.of(entry('Enter', 90, 'b', false, log)), Prec.high(keyChains.of(entry('Enter', 90, 'c', false, log)))],
    });
    expect(chainFor(state, 'Enter').map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expect(runChain(fakeView(state), 'Enter')).toBe(false);
    expect(log).toEqual(['c', 'a', 'b']);
  });

  it('skips an entry that throws, with a warning, and goes on down the chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    const broken: KeyChainEntry = { key: 'Backspace', priority: 100, id: 'broken', run: () => { throw new Error('boom'); } };
    const state = EditorState.create({ extensions: [keyChains.of(broken), keyChains.of(entry('Backspace', 90, 'pair', true, log))] });
    expect(runChain(fakeView(state), 'Backspace')).toBe(true);
    expect(log).toEqual(['pair']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('the keymap', () => {
  it('binds every chain key once, at the highest precedence, through the chain', () => {
    const log: string[] = [];
    const state = EditorState.create({ extensions: [keyChainsExtension(), keyChains.of(entry('Mod-ArrowRight', 80, 'word', true, log))] });
    const bindings = state.facet(keymap).flat() as KeyBinding[];
    const chainKeys = bindings.filter((b) => CHAIN_KEYS.includes(b.key as never));
    expect(chainKeys.map((b) => b.key).sort()).toEqual([...CHAIN_KEYS].sort());
    const word = chainKeys.find((b) => b.key === 'Mod-ArrowRight')!;
    expect(word.run!(fakeView(state))).toBe(true);
    expect(log).toEqual(['word']);
    const backspace = chainKeys.find((b) => b.key === 'Backspace')!;
    expect(backspace.run!(fakeView(state)), 'an empty chain lets the key through').toBe(false);
  });
});
