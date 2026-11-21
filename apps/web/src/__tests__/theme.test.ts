import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APPEARANCES, parseAppearance, resolveTheme, THEME_COLOR, toggled, type Appearance, type Theme } from '../theme';
import { lookOf } from '../settings/apply';
import { UI_SCALES } from '../settings/registry/core';

const INDEX = fileURLToPath(new URL('../../index.html', import.meta.url));

type Stored = Record<string, string> | string | null | Error;

/** Run index.html's pre-paint script against stored values and a system setting.
 *  A string or null is the stored theme alone; an Error makes every read throw;
 *  'blocked' in `o` makes reading window.localStorage itself throw. */
function prepaint(stored: Stored, systemDark: boolean | 'no-matchMedia', o: { blocked?: boolean } = {}) {
  const html = readFileSync(INDEX, 'utf8');
  const code = /<script data-prepaint>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!code) throw new Error('index.html has no <script data-prepaint>');
  const values: Record<string, string> = typeof stored === 'string' ? { 'aldine.theme': stored } : stored && !(stored instanceof Error) ? stored : {};
  const meta = { content: null as string | null, setAttribute(_: string, v: string) { this.content = v; } };
  const root = { dataset: {} as Record<string, string>, style: { fontSize: '' } };
  const document = { documentElement: root, querySelector: () => meta };
  const storage = { getItem: (k: string) => { if (stored instanceof Error) throw stored; return values[k] ?? null; } };
  const window = {
    get localStorage() { if (o.blocked) throw new Error('SecurityError'); return storage; },
    matchMedia: systemDark === 'no-matchMedia' ? undefined : () => ({ matches: systemDark }),
  };
  new Function('window', 'document', code)(window, document);
  return { theme: root.dataset.theme, color: meta.content, fontSize: root.style.fontSize, contrast: root.dataset.contrast, motion: root.dataset.motion };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('appearance', () => {
  it('follows the system when nothing, or nothing it knows, is stored', () => {
    expect(parseAppearance(null)).toBe('system');
    expect(parseAppearance(undefined)).toBe('system');
    expect(parseAppearance('sepia')).toBe('system');
    expect(parseAppearance('light')).toBe('light');
    expect(parseAppearance('dark')).toBe('dark');
    expect(parseAppearance('system')).toBe('system');
  });

  it('asks the system only for "Match system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('a light/dark switch makes the opposite of what is on screen explicit', () => {
    expect(toggled('dark')).toBe('light');
    expect(toggled('light')).toBe('dark');
  });

  it('offers the three choices in the order the menus show them', () => {
    expect(APPEARANCES.map((a) => a.label)).toEqual(['Match system', 'Light', 'Dark']);
  });
});

describe('the pre-paint script in index.html', () => {
  const cases: [string | null, boolean][] = [
    [null, false], [null, true], ['dark', false], ['light', true], ['system', true], ['system', false], ['bogus', false],
  ];
  for (const [stored, systemDark] of cases) {
    it(`agrees with theme.ts for ${stored ?? 'nothing stored'} on a ${systemDark ? 'dark' : 'light'} system`, () => {
      const want: Theme = resolveTheme(parseAppearance(stored), systemDark);
      const got = prepaint(stored, systemDark);
      expect({ theme: got.theme, color: got.color }).toEqual({ theme: want, color: THEME_COLOR[want] });
    });
  }

  it('follows the system when storage is blocked, and paints dark when the system cannot be asked', () => {
    expect(prepaint(new Error('SecurityError'), false).theme).toBe('light');
    expect(prepaint(new Error('SecurityError'), true).theme).toBe('dark');
    expect(prepaint(null, false, { blocked: true }).theme).toBe('light');
    expect(prepaint(null, true, { blocked: true }).theme).toBe('dark');
    expect(prepaint(new Error('SecurityError'), 'no-matchMedia').theme).toBe('dark');
    expect(prepaint('system' as Appearance, 'no-matchMedia').theme).toBe('dark');
    expect(prepaint(null, 'no-matchMedia').theme).toBe('dark');
  });

  it('applies the interface size, contrast and motion exactly as settings/apply.ts does', () => {
    for (const scale of UI_SCALES) {
      const got = prepaint({ 'aldine.appearance.scale': JSON.stringify(scale) }, false);
      expect(got.fontSize, `${scale}%`).toBe(lookOf((id) => (id === 'appearance.scale' ? scale : undefined)).fontSize);
    }
    const all = prepaint({ 'aldine.theme': 'light', 'aldine.appearance.contrast': '"more"', 'aldine.appearance.motion': '"reduce"' }, true);
    expect(all).toMatchObject({ theme: 'light', contrast: 'more', motion: 'reduce' });
    const look = lookOf((id) => ({ 'appearance.contrast': 'more', 'appearance.motion': 'reduce' } as Record<string, unknown>)[id]);
    expect([look.attrs.contrast, look.attrs.motion]).toEqual(['more', 'reduce']);
  });

  it('ignores values it does not know, and changes nothing when storage throws', () => {
    const junk = prepaint({ 'aldine.appearance.scale': '105', 'aldine.appearance.contrast': 'more', 'aldine.appearance.motion': '{' }, false);
    expect(junk).toMatchObject({ fontSize: '', contrast: undefined, motion: undefined });
    expect(prepaint(new Error('SecurityError'), false)).toMatchObject({ fontSize: '', contrast: undefined, motion: undefined });
    expect(prepaint(null, false, { blocked: true })).toMatchObject({ fontSize: '', contrast: undefined, motion: undefined });
  });
});

describe('theme.ts on the settings store', () => {
  async function load(stored: Record<string, string> = {}) {
    const map = new Map(Object.entries(stored));
    const localStorage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) }));
    vi.resetModules();
    return { theme: await import('../theme'), map };
  }

  it('reads the stored choice through the store, unknown text as "Match system"', async () => {
    expect((await load({ 'aldine.theme': 'light' })).theme.getAppearance()).toBe('light');
    const { theme } = await load({ 'aldine.theme': 'sepia' });
    expect(theme.getAppearance()).toBe('system');
    expect(theme.getTheme()).toBe('dark');
  });

  it('stores a choice under aldine.theme in V1’s words', async () => {
    const { theme, map } = await load();
    theme.setAppearance('light');
    expect(map.get('aldine.theme')).toBe('light');
    expect(theme.toggleTheme()).toBe('dark');
    expect(map.get('aldine.theme')).toBe('dark');
    theme.setAppearance('system');
    expect(map.get('aldine.theme')).toBe('system');
    expect(theme.getAppearance()).toBe('system');
  });
});
