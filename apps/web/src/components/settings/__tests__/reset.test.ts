import { describe, expect, it } from 'vitest';
import type { AnySettingDef } from '../../../settings/types';
import { applyValues, isChanged, namesText, resetDefs, restore, storageKey, type ResetStore } from '../reset';

const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const vim: AnySettingDef = { id: 'editor.vim', section: 'editor-behaviour', label: 'Vim keybindings', scope: 'account', default: false, validate: bool, key: 'aldine.vim', control: { kind: 'switch' } };
const size: AnySettingDef = { id: 'editor.fontSize', section: 'editor-text', label: 'Font size', scope: 'account', default: 13.5, validate: (v): v is number => typeof v === 'number', control: { kind: 'slider', min: 10, max: 24, step: 0.5 } };
const lig: AnySettingDef = { id: 'editor.ligatures', section: 'editor-text', label: 'Font ligatures', scope: 'account', default: false, validate: bool, control: { kind: 'switch' } };
const project: AnySettingDef = { id: 'wordcount.rule', section: 'wordcount', label: 'Count', scope: 'project', default: 'main', validate: (v): v is string => typeof v === 'string', control: { kind: 'text' } };
const defs = [vim, size, lig, project];

/** A store over a fake localStorage, with V1's codec for aldine.vim (on only for '1') and JSON elsewhere. */
function fakeStore(initial: Record<string, string>) {
  const storage = new Map(Object.entries(initial));
  const sets: string[] = [];
  const decode = (def: AnySettingDef): unknown => {
    const raw = storage.get(storageKey(def)) ?? null;
    if (def.id === 'editor.vim') return raw === '1';
    if (raw === null) return def.default;
    try { const v = JSON.parse(raw); return def.validate(v) ? v : def.default; } catch { return def.default; }
  };
  const def = (id: string) => defs.find((d) => d.id === id)!;
  const s: ResetStore = {
    get: (id) => decode(def(id)),
    dflt: (d) => d.default,
    set: (id, v) => {
      const d = def(id);
      if (decode(d) === v) return;
      sets.push(id);
      storage.set(storageKey(d), id === 'editor.vim' ? (v ? '1' : '0') : JSON.stringify(v));
    },
    reset: (id) => { storage.delete(storageKey(def(id))); },
    raw: (key) => storage.get(key) ?? null,
    writeRaw: (key, raw) => { if (raw === null) storage.delete(key); else storage.set(key, raw); },
  };
  return { s, storage, sets };
}

describe('settings reset and undo', () => {
  it('resets only what differs from the default or has a key, never project settings', () => {
    const { s, storage } = fakeStore({ 'aldine.vim': '1', 'aldine.editor.fontSize': '16' });
    const snap = resetDefs(defs, s);
    expect(snap.map((e) => e.id)).toEqual(['editor.vim', 'editor.fontSize']);
    expect([...storage.keys()]).toEqual([]);
    expect(isChanged(vim, s)).toBe(false);
  });

  it('undo puts back the values and the exact stored text, legacy junk included', () => {
    const before = { 'aldine.vim': '1', 'aldine.editor.fontSize': '16', 'aldine.editor.ligatures': 'junk' };
    const { s, storage } = fakeStore(before);
    const snap = resetDefs(defs, s);
    restore(snap, s);
    expect(Object.fromEntries(storage)).toEqual(before);
  });

  it('an import is one undo step', () => {
    const { s, storage } = fakeStore({ 'aldine.vim': '0' });
    const snap = applyValues([{ def: vim, to: true }, { def: size, to: 15 }], s);
    expect(Object.fromEntries(storage)).toEqual({ 'aldine.vim': '1', 'aldine.editor.fontSize': '15' });
    restore(snap, s);
    expect(Object.fromEntries(storage)).toEqual({ 'aldine.vim': '0' });
  });

  it('names a few settings in a sentence', () => {
    expect(namesText(['Theme'])).toBe('Theme');
    expect(namesText(['Theme', 'Font size'])).toBe('Theme and Font size');
    expect(namesText(['Theme', 'Font size', 'Vim'])).toBe('Theme, Font size and Vim');
    expect(namesText(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more');
  });
});
