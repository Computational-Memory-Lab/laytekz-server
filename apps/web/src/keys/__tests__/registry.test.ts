import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeybindingDef } from '../types';

// This file covers the registry on its own storage (no settings store, as in
// an isolated build); registry-store.test.ts covers it behind the store.
const stored = new Map<string, string>();
vi.mock('../../util/safeStorage', () => ({
  safeStorage: {
    get: (k: string) => stored.get(k) ?? null,
    set: (k: string, v: string) => { stored.set(k, v); return true; },
    remove: (k: string) => { stored.delete(k); },
    getJSON: <T,>(k: string, fallback: T) => { const v = stored.get(k); if (v == null) return fallback; try { return JSON.parse(v) as T; } catch { return fallback; } },
    setJSON: (k: string, v: unknown) => { stored.set(k, JSON.stringify(v)); return true; },
  },
}));
vi.mock('../../settings/store', () => {
  const missing = () => { throw new Error('Not implemented yet: settings/store'); };
  return { getSetting: missing, setSetting: missing, resetSetting: missing, subscribeSetting: missing };
});

const key = (k: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing', boolean>> = {}) =>
  ({ key: k, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...mods, getModifierState: () => false }) as unknown as KeyboardEvent;

type Registry = typeof import('../registry');
let reg: Registry;

beforeEach(async () => {
  stored.clear();
  vi.resetModules();
  reg = await import('../registry');
});
afterEach(() => vi.restoreAllMocks());

const cite: KeybindingDef = {
  id: 'citations.insert', label: 'Insert citation', group: 'Citations',
  default: { mod: true, shift: true, alt: false, key: 'e' }, changeable: true, scope: 'page', command: 'citations.insert',
};
const align: KeybindingDef = {
  id: 'tables.align', label: 'Align table', group: 'Tables',
  default: { mod: false, shift: true, alt: true, key: 'a' }, changeable: true, scope: 'editor', command: 'tables.align', matchCode: true,
};
const print: KeybindingDef = {
  id: 'outputs.print', label: 'Print the PDF', group: 'PDF',
  default: { mod: true, shift: false, alt: false, key: 'p' }, changeable: true, scope: 'page', command: 'outputs.print', desktop: 'native-menu',
};

describe('the binding list', () => {
  it('lists the core bindings first, V1 shortcuts unchanged, then registered ones, and removes them again', () => {
    const ids = () => reg.keybindings().map((d) => d.id);
    expect(ids().slice(0, 5)).toEqual(['typeset', 'comment', 'jump', 'palette', 'search']);
    expect(ids()).toContain('settings');
    const remove = reg.registerKeybindings([cite]);
    expect(ids().at(-1)).toBe('citations.insert');
    expect(reg.keybinding('citations.insert')?.label).toBe('Insert citation');
    remove();
    expect(ids()).not.toContain('citations.insert');
  });

  it('skips a duplicate or malformed binding with a warning instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerKeybindings([cite, { ...cite, label: 'Twin' }, { ...cite, id: 'comment' }, { ...cite, id: 'x.bad', scope: 'nowhere' as never }]);
    expect(reg.keybindings().filter((d) => d.id === 'citations.insert')).toHaveLength(1);
    expect(reg.keybinding('citations.insert')?.label).toBe('Insert citation');
    expect(reg.keybinding('comment')?.label).toBe('Comment on the selection');
    expect(reg.keybinding('x.bad')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('chords and overrides', () => {
  it('gives the default, an override, or null for a cleared binding, and labels it', () => {
    reg.registerKeybindings([cite]);
    expect(reg.chordFor('citations.insert')).toEqual(cite.default);
    expect(reg.chordLabel('comment')).toMatch(/⇧⌘C|Ctrl\+Shift\+C/);
    reg.setChord('citations.insert', { mod: true, shift: false, alt: false, key: 'e', code: 'KeyE' });
    expect(reg.chordFor('citations.insert')?.shift).toBe(false);
    expect(reg.isOverridden('citations.insert')).toBe(true);
    reg.setChord('citations.insert', null);
    expect(reg.chordFor('citations.insert')).toBeNull();
    expect(reg.chordLabel('citations.insert')).toBe('');
    expect(reg.isOverridden('citations.insert'), 'cleared is a choice, so Reset shows').toBe(true);
    reg.setChord('citations.insert', { ...cite.default!, code: 'KeyE' });
    expect(reg.isOverridden('citations.insert'), 'the default chord removes the override').toBe(false);
    expect(JSON.parse(stored.get('aldine.shortcuts')!)).toEqual({});
  });

  it('keeps entries for bindings this page has not registered, and V1 entries in their V1 shape', () => {
    stored.set('aldine.shortcuts', JSON.stringify({
      jump: { mod: true, shift: true, alt: false, key: 'j', code: 'KeyJ' },
      'highlighter.highlight': { mod: true, shift: true, alt: false, key: 'y', code: 'KeyY' },
      'links.follow': null,
      junk: 'not a chord',
    }));
    reg.setChord('comment', { mod: true, shift: false, alt: false, key: 'e', code: 'KeyE' });
    const saved = JSON.parse(stored.get('aldine.shortcuts')!);
    expect(saved.comment).toEqual({ mod: true, shift: false, alt: false, key: 'e', code: 'KeyE' });
    expect(saved.jump).toEqual({ mod: true, shift: true, alt: false, key: 'j', code: 'KeyJ' });
    expect(saved['highlighter.highlight'].key).toBe('y');
    expect(saved['links.follow']).toBeNull();
    expect(saved.junk, 'what it cannot read it leaves alone').toBe('not a chord');
    expect(reg.chordFor('jump')?.shift).toBe(true);
  });

  it('never changes a binding that is not changeable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixed: KeybindingDef = { ...cite, id: 'x.fixed', changeable: false };
    reg.registerKeybindings([fixed]);
    reg.setChord('x.fixed', { mod: true, shift: false, alt: false, key: 'e' });
    expect(reg.chordFor('x.fixed')).toEqual(fixed.default);
    expect(stored.has('aldine.shortcuts')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('tells subscribers about a change from another tab', async () => {
    const listeners: ((e: { key: string | null }) => void)[] = [];
    vi.stubGlobal('window', { addEventListener: (t: string, fn: (e: { key: string | null }) => void) => { if (t === 'storage') listeners.push(fn); } });
    try {
      vi.resetModules();
      reg = await import('../registry');
      const seen: string[] = [];
      const off = reg.subscribeKeybindings(() => seen.push(reg.chordLabel('palette')));
      stored.set('aldine.shortcuts', JSON.stringify({ palette: { mod: true, shift: true, alt: false, key: 'p', code: 'KeyP' } }));
      listeners.forEach((l) => l({ key: 'aldine.shortcuts' }));
      expect(seen.at(-1)).toMatch(/⇧⌘P|Ctrl\+Shift\+P/);
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('dispatching a keydown', () => {
  // metaKey is the modifier on every platform (the Windows key counts as Ctrl); a Mac's Ctrl never is.
  it('finds the binding among the scopes asked for', () => {
    reg.registerKeybindings([cite, align]);
    const e = key('E', 'KeyE', { metaKey: true, shiftKey: true });
    expect(reg.bindingFor(e, ['page'])?.id).toBe('citations.insert');
    expect(reg.bindingFor(e, ['editor', 'page-capture'])).toBeNull();
    expect(reg.bindingFor(key('e', 'KeyE', { metaKey: true }), ['page'])).toBeNull();
    expect(reg.bindingFor(key('E', 'KeyE', { metaKey: true, shiftKey: true, altKey: true }), ['page'])).toBeNull();
  });

  it('matches a code-matched binding by the physical key, whatever Option types', () => {
    reg.registerKeybindings([align]);
    // ⇧⌥A types Å on a Mac; the binding still finds it by KeyA.
    expect(reg.bindingFor(key('Å', 'KeyA', { shiftKey: true, altKey: true }), ['editor'])?.id).toBe('tables.align');
    expect(reg.matchesShortcut(key('Å', 'KeyA', { shiftKey: true, altKey: true }), 'tables.align')).toBe(true);
    expect(reg.bindingFor(key('Å', 'KeyQ', { shiftKey: true, altKey: true }), ['editor'])).toBeNull();
  });

  it('skips the desktop menu\'s chords in the desktop app, and everything while composing', () => {
    reg.registerKeybindings([print]);
    const p = key('p', 'KeyP', { metaKey: true });
    expect(reg.bindingFor(p, ['page'])?.id).toBe('outputs.print');
    expect(reg.bindingFor(p, ['page'], { desktop: true })).toBeNull();
    const comma = key(',', 'Comma', { metaKey: true });
    expect(reg.bindingFor(comma, ['page'])?.id).toBe('settings');
    expect(reg.bindingFor(comma, ['page'], { desktop: true })).toBeNull();
    expect(reg.bindingFor(key('p', 'KeyP', { metaKey: true, isComposing: true }), ['page'])).toBeNull();
  });

  it('matches nothing for a cleared binding', () => {
    reg.registerKeybindings([cite]);
    reg.setChord('citations.insert', null);
    const e = key('E', 'KeyE', { shiftKey: true, metaKey: true });
    expect(reg.bindingFor(e, ['page'])).toBeNull();
    expect(reg.matchesShortcut(e, 'citations.insert')).toBe(false);
  });

  it('follows at Alt+Enter, NumpadEnter included', () => {
    expect(reg.bindingFor(key('Enter', 'Enter', { altKey: true }), ['editor'])?.id).toBe('follow');
    expect(reg.bindingFor(key('Enter', 'NumpadEnter', { altKey: true }), ['editor'])?.id).toBe('follow');
    expect(reg.bindingFor(key('Enter', 'Enter', { altKey: true }), ['page'])).toBeNull();
  });
});

describe('choosing a chord', () => {
  it('accepts Alt+Enter and Shift+Alt+Enter without ⌘, and refuses other Option chords', () => {
    expect(reg.chordProblem({ mod: false, shift: false, alt: true, key: 'Enter', code: 'Enter' }, 'follow', true)).toBeNull();
    expect(reg.chordProblem({ mod: false, shift: true, alt: true, key: 'Enter', code: 'Enter' }, 'crossrefs.references', true)).toBeNull();
    expect(reg.chordProblem({ mod: false, shift: true, alt: true, key: 'Enter', code: 'Enter' }, 'crossrefs.references', false)).toBeNull();
    expect(reg.chordProblem({ mod: false, shift: false, alt: true, key: 'e', code: 'KeyE' }, 'x.y', true)).toMatch(/Hold ⌘/);
    expect(reg.chordProblem({ mod: false, shift: false, alt: true, key: 'e', code: 'KeyE' }, 'x.y', false)).toMatch(/Hold Ctrl/);
  });

  it('accepts the code-matched Option chords ⇧⌥A and ⌥\\, and refuses ⇧⌥F as Format document', () => {
    expect(reg.chordProblem({ mod: false, shift: true, alt: true, key: 'a', code: 'KeyA' }, 'tables.align', true)).toBeNull();
    expect(reg.chordProblem({ mod: false, shift: false, alt: true, key: '«', code: 'Backslash' }, 'suggest.request', true)).toBeNull();
    expect(reg.chordProblem({ mod: false, shift: true, alt: true, key: 'f', code: 'KeyF' }, 'tables.align', false)).toBe('Alt+Shift+F is Format document in the editor');
  });

  it('refuses Ctrl+Alt chords (AltGr) on both platforms', () => {
    expect(reg.chordProblem({ mod: true, shift: false, alt: true, key: 'p', code: 'KeyP' }, 'x.y', false)).toMatch(/AltGr/);
    expect(reg.chordProblem({ mod: true, shift: false, alt: true, key: 'p', code: 'KeyP' }, 'x.y', true)).toMatch(/Ctrl\+Alt on Windows/);
  });

  it('refuses the devtools, browser, macOS and desktop-menu chords, platform by platform', () => {
    const c = (k: string, shift = true) => ({ mod: true, shift, alt: false, key: k, code: `Key${k.toUpperCase()}` });
    expect(reg.chordProblem(c('i'), 'x.y', true)).toBe("⇧⌘I belongs to the browser's developer tools");
    expect(reg.chordProblem(c('l'), 'x.y', false)).toBe('Ctrl+Shift+L is Select all matches in the editor');
    expect(reg.chordProblem(c('p'), 'x.y', true)).toBe('⇧⌘P belongs to the browser');
    expect(reg.chordProblem(c('y'), 'x.y', true)).toBe('⇧⌘Y belongs to macOS (Stickies)');
    expect(reg.chordProblem(c('y'), 'x.y', false), 'Stickies is a Mac thing').toBeNull();
    expect(reg.chordProblem(c('m', false), 'x.y', true)).toBe('⌘M belongs to macOS (minimise the window)');
    expect(reg.chordProblem(c('m', false), 'x.y', false)).toBe('Ctrl+M is Tab moves focus in the editor');
    expect(reg.chordProblem({ mod: true, shift: false, alt: false, key: '`', code: 'Backquote' }, 'x.y', false)).toBe("Ctrl+` belongs to the desktop app's console");
    expect(reg.chordProblem({ mod: true, shift: false, alt: false, key: ',', code: 'Comma' }, 'x.y', true)).toBe('⌘, is already Open settings');
    expect(reg.chordProblem({ mod: false, shift: true, alt: false, key: 'F10', code: 'F10' }, 'x.y', false)).toBe('Shift+F10 belongs to the context menu');
  });

  it('lets a binding take its own default back, even a reserved one (comment keeps ⇧⌘C)', () => {
    const c = { mod: true, shift: true, alt: false, key: 'c', code: 'KeyC' };
    expect(reg.chordProblem(c, 'comment', true)).toBeNull();
    expect(reg.chordProblem(c, 'x.y', true)).toBe("⇧⌘C belongs to the browser's developer tools");
  });

  it('names a registered binding that already has the keys', () => {
    reg.registerKeybindings([cite]);
    expect(reg.chordProblem({ mod: true, shift: true, alt: false, key: 'e', code: 'KeyE' }, 'comment', true)).toBe('⇧⌘E is already Insert citation');
    reg.setChord('jump', { mod: true, shift: true, alt: false, key: 'e', code: 'KeyE' });
    expect(reg.chordConflict('jump')).toBe('Insert citation');
    expect(reg.chordConflict('citations.insert')).toBe('Jump the PDF to the cursor');
  });
});

describe('the reserved list', () => {
  it('is exported in the frozen shape, with the editor\'s commands worded as such', () => {
    expect(reg.RESERVED.length).toBeGreaterThan(30);
    for (const r of reg.RESERVED) {
      expect(r.platforms.length).toBeGreaterThan(0);
      expect(typeof r.owner).toBe('string');
    }
    expect(reg.RESERVED.find((r) => r.chord.key === 'b' && r.chord.mod && !r.chord.shift)?.owner).toBe('Bold in the editor');
  });
});
