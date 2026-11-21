import { beforeEach, describe, expect, it, vi } from 'vitest';

// The registry behind the settings store (WP02): overrides are the value of
// CORE_SETTING_IDS.shortcuts, so they sync with the account and other tabs.
const store = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const subs = new Map<string, Set<() => void>>();
  const fire = (id: string) => subs.get(id)?.forEach((fn) => fn());
  return {
    values,
    fire,
    getSetting: vi.fn((id: string) => (values.has(id) ? values.get(id) : {})),
    setSetting: vi.fn((id: string, v: unknown) => { values.set(id, v); fire(id); }),
    resetSetting: vi.fn((id: string) => { values.delete(id); fire(id); }),
    subscribeSetting: vi.fn((ids: string | string[], fn: () => void) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        if (!subs.has(id)) subs.set(id, new Set());
        subs.get(id)!.add(fn);
      }
      return () => {};
    }),
  };
});
vi.mock('../../settings/store', () => ({
  getSetting: store.getSetting, setSetting: store.setSetting, resetSetting: store.resetSetting, subscribeSetting: store.subscribeSetting,
}));
const local = vi.hoisted(() => ({ setJSON: vi.fn(() => true), getJSON: vi.fn(<T,>(_k: string, f: T) => f) }));
vi.mock('../../util/safeStorage', () => ({ safeStorage: { get: () => null, set: () => true, remove: () => {}, getJSON: local.getJSON, setJSON: local.setJSON } }));

type Registry = typeof import('../registry');
let reg: Registry;

beforeEach(async () => {
  store.values.clear();
  vi.clearAllMocks();
  vi.resetModules();
  reg = await import('../registry');
});

const modE = { mod: true, shift: false, alt: false, key: 'e', code: 'KeyE' };

describe('overrides through the settings store', () => {
  it('reads keys.shortcuts and writes the whole map back, never localStorage directly', () => {
    store.values.set('keys.shortcuts', { search: { mod: true, shift: true, alt: false, key: 'y', code: 'KeyY' }, 'stats.insert': null });
    expect(reg.chordLabel('search')).toMatch(/⇧⌘Y|Ctrl\+Shift\+Y/);
    reg.setChord('comment', modE);
    expect(store.setSetting).toHaveBeenLastCalledWith('keys.shortcuts', {
      search: { mod: true, shift: true, alt: false, key: 'y', code: 'KeyY' }, 'stats.insert': null, comment: modE,
    });
    expect(local.setJSON).not.toHaveBeenCalled();
  });

  it('resets the setting when the last override goes, so the account holds nothing either', () => {
    reg.setChord('comment', modE);
    reg.setChord('comment', { mod: true, shift: true, alt: false, key: 'c' });
    expect(store.resetSetting).toHaveBeenCalledWith('keys.shortcuts');
    expect(reg.isOverridden('comment')).toBe(false);
  });

  it('follows a change that arrives through the store (another tab, the account)', () => {
    const labels: string[] = [];
    reg.subscribeKeybindings(() => labels.push(reg.chordLabel('jump')));
    store.values.set('keys.shortcuts', { jump: { mod: true, shift: true, alt: false, key: 'u', code: 'KeyU' } });
    store.fire('keys.shortcuts');
    expect(labels.at(-1)).toMatch(/⇧⌘U|Ctrl\+Shift\+U/);
  });

  it('treats a value that is not a map as no overrides', () => {
    store.values.set('keys.shortcuts', ['nonsense']);
    expect(reg.chordLabel('palette')).toMatch(/⌘K|Ctrl\+K/);
    expect(reg.isOverridden('palette')).toBe(false);
  });
});
