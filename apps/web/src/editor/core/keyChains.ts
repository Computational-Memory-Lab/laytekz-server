/**
 * Key chains (WP04 input-core): one keymap for the keys several features want
 * (Tab, Escape, Enter, Backspace …). Each key runs its entries from the
 * highest priority down and stops at the first that handles it; when none
 * does, the key goes on to the editor's other keymaps as if the chain were
 * not there.
 */
import { Facet, Prec, type EditorState, type Extension } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { acceptCompletion, closeCompletion } from '@codemirror/autocomplete';
import { indentLess, indentMore } from '@codemirror/commands';
import { KEY_CHAIN_PRIORITY, type ChainKey, type KeyChainEntry } from './types';

/** Features provide `keyChains.of(entry)` (the editor host does it for
 *  EditorContribution.keyChains, inside the feature's compartment). */
export const keyChains: Facet<KeyChainEntry, readonly KeyChainEntry[]> = Facet.define<KeyChainEntry>();

export const CHAIN_KEYS: readonly ChainKey[] = ['Tab', 'Shift-Tab', 'Enter', 'Backspace', 'Escape', 'Mod-ArrowRight'];

/**
 * The editor's own links, moved here unchanged from CodePane: Tab takes the
 * highlighted completion (acceptCompletion declines for CodeMirror's 75 ms
 * interactionDelay after the list opens, and Tab then indents), otherwise it
 * indents, and Shift-Tab outdents (indentWithTab); Escape closes the list
 * (completionKeymap).
 */
export const CORE_CHAIN: readonly KeyChainEntry[] = [
  { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.completion, id: 'core.acceptCompletion', run: acceptCompletion },
  { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.indent, id: 'core.indent', run: indentMore },
  { key: 'Shift-Tab', priority: KEY_CHAIN_PRIORITY.Tab.indent, id: 'core.outdent', run: indentLess },
  { key: 'Escape', priority: KEY_CHAIN_PRIORITY.Escape.completion, id: 'core.closeCompletion', run: closeCompletion },
];

const sorted = new WeakMap<readonly KeyChainEntry[], Map<ChainKey, readonly KeyChainEntry[]>>();

/** `key`'s entries in `state`, highest priority first; equal priorities keep
 *  their facet order (extension precedence, then position). */
export function chainFor(state: EditorState, key: ChainKey): readonly KeyChainEntry[] {
  const entries = state.facet(keyChains);
  let byKey = sorted.get(entries);
  if (!byKey) {
    byKey = new Map();
    for (const k of CHAIN_KEYS) byKey.set(k, entries.filter((e) => e.key === k).sort((a, b) => b.priority - a.priority));
    sorted.set(entries, byKey);
  }
  return byKey.get(key) ?? [];
}

/** Runs `key`'s chain on `view`; true when an entry handled it. An entry that
 *  throws is skipped with a warning, so one broken feature never eats the key. */
export function runChain(view: EditorView, key: ChainKey): boolean {
  for (const entry of chainFor(view.state, key)) {
    try {
      if (entry.run(view)) return true;
    } catch (err) {
      console.warn(`Key chain ${key}: ${entry.id} failed`, err);
    }
  }
  return false;
}

/** One Prec.highest keymap after Vim that runs each key's entries in
 *  priority order; includes WP04's own entries (Tab: completion 100, indent
 *  0; Escape: completion 100). The editor host installs it once. */
export function keyChainsExtension(): Extension {
  return [
    CORE_CHAIN.map((e) => keyChains.of(e)),
    Prec.highest(keymap.of(CHAIN_KEYS.map((key) => ({ key, run: (view: EditorView) => runChain(view, key) })))),
  ];
}
