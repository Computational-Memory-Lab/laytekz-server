import { describe, expect, it } from 'vitest';
import { SECTIONS, settingsIn } from '../../../settings/registry';
import { DEFAULT_CAPABILITIES } from '../../../settings/capabilities';
import type { SettingsEnv } from '../../../settings/types';
import { embeddedSections, pageSections } from '../model';
import { countText, EMBEDDED_TERMS, matches, searchSections } from '../search';

const env: SettingsEnv = { accounts: false, signedIn: false, desktop: false, phone: false, capabilities: DEFAULT_CAPABILITIES, project: null };
const page = () => pageSections(SECTIONS, settingsIn, env, embeddedSections({ accounts: false, signedIn: false, project: false }));
const terms = (id: string) => EMBEDDED_TERMS[id as keyof typeof EMBEDDED_TERMS] ?? [];
const rowIds = (q: string) => searchSections(page(), q, terms).sections.flatMap((s) => [...s.rows, ...s.automatic].map((d) => d.id));

describe('settings search', () => {
  it('finds Font, Font size and Font ligatures for "font" (the real registry)', () => {
    const ids = rowIds('font');
    for (const id of ['editor.font', 'editor.fontSize', 'editor.ligatures']) expect(ids).toContain(id);
    // only rows that name fonts, by label or keyword
    expect(ids).not.toContain('editor.vim');
    expect(ids).not.toContain('appearance.theme');
  });

  it('finds Theme and "PDF in the dark theme" for "dark", through keywords', () => {
    const ids = rowIds('dark');
    expect(ids).toContain('appearance.theme');
    expect(ids).toContain('pdf.dark');
  });

  it('shows a whole section when its title matches', () => {
    const r = searchSections(page(), 'typesetting', terms);
    const s = r.sections.find((x) => x.def.id === 'typesetting');
    expect(s?.rows.map((d) => d.id)).toEqual(expect.arrayContaining(['typesetting.auto', 'typesetting.draft']));
  });

  it('hides sections with nothing that matches, and counts what does', () => {
    const r = searchSections(page(), 'ligatures', terms);
    expect(r.sections.map((s) => s.def.id)).toEqual(['editor-text']);
    expect(r.count).toBe(1);
    expect(countText('ligatures', r.count)).toBe('1 setting matches');
    expect(countText('zzqx', 0)).toBe('No settings match “zzqx”');
    expect(countText('', 3)).toBe('');
  });

  it('shows an embedded block when one of its terms matches', () => {
    const r = searchSections(page(), 'your name', terms);
    const account = r.sections.find((s) => s.def.id === 'account');
    expect(account?.embeddedShown).toBe(true);
  });

  it('shows everything, embedded blocks included, with nothing typed', () => {
    const r = searchSections(page(), '  ', terms);
    expect(r.sections.length).toBe(page().length);
    expect(r.sections.find((s) => s.def.id === 'shortcuts')?.embeddedShown).toBe(true);
  });

  it('does not match scattered letters', () => {
    expect(matches('fnt', 'Font')).toBe(false);
    expect(matches('fon', 'Font size')).toBe(true);
    expect(matches('size', 'Interface text size')).toBe(true);
    expect(matches('dar', 'Theme', 'appearance dark light')).toBe(true);
  });
});
