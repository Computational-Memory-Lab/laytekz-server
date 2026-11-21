import { describe, expect, it } from 'vitest';
import { REGISTRY_PROBLEMS, SECTIONS, SETTINGS, settingDef } from '../registry';
import { CORE_SETTINGS, SPELL_LANG_OPTIONS, UI_SCALES } from '../registry/core';
import { CORE_SETTING_IDS, PREF_KEY_RE } from '../types';
import { JSON_CODEC } from '../codecs';
import { SPELL_LANGS, SPELLCHECK, SPELLCHECK_LANG } from '../../editor/spellcheck';
import { THEME_KEY } from '../../theme';
import { LAYOUT } from '../../util/layout';

const keyOf = (d: { id: string; key?: string }) => d.key ?? `aldine.${d.id}`;

describe('the settings registry', () => {
  it('has no problems', () => {
    expect(REGISTRY_PROBLEMS).toEqual([]);
  });

  it('defines every frozen core id', () => {
    for (const id of Object.values(CORE_SETTING_IDS)) expect(settingDef(id), id).toBeDefined();
  });

  it('keeps each V1 preference on its V1 key', () => {
    const key = (id: string) => keyOf(settingDef(id)!);
    expect(key(CORE_SETTING_IDS.theme)).toBe(THEME_KEY);
    expect(key(CORE_SETTING_IDS.shortcuts)).toBe('aldine.shortcuts');
    expect(key(CORE_SETTING_IDS.autoTypeset)).toBe('aldine.autoTypeset');
    expect(key(CORE_SETTING_IDS.draftTypeset)).toBe('aldine.draftTypeset');
    expect(key(CORE_SETTING_IDS.spellcheck)).toBe(SPELLCHECK);
    expect(key(CORE_SETTING_IDS.spellLang)).toBe(SPELLCHECK_LANG);
    expect(key(CORE_SETTING_IDS.vim)).toBe('aldine.vim');
    expect(key(CORE_SETTING_IDS.changeMarks)).toBe('aldine.changeMarks');
    expect(key(CORE_SETTING_IDS.editorMode)).toBe('aldine.editorMode');
    expect(key(CORE_SETTING_IDS.layout)).toBe(LAYOUT);
    expect(key(CORE_SETTING_IDS.pdfZoom)).toBe('aldine.pdfZoom');
    expect(key(CORE_SETTING_IDS.agentPresence)).toBe('aldine.experimental.agentPresence');
  });

  it('scopes the core settings as the contract says', () => {
    const scope = (id: string) => settingDef(id)!.scope;
    for (const id of [CORE_SETTING_IDS.editorMode, CORE_SETTING_IDS.layout, CORE_SETTING_IDS.pdfZoom, CORE_SETTING_IDS.agentPresence]) expect(scope(id), id).toBe('device');
    for (const id of [CORE_SETTING_IDS.explainAutomatic, CORE_SETTING_IDS.contextMenu]) expect(scope(id), id).toBe('account');
    expect(settingDef(CORE_SETTING_IDS.explainAutomatic)!.default).toBe(true);
    expect(settingDef(CORE_SETTING_IDS.contextMenu)!.default).toBe(true);
    expect(settingDef(CORE_SETTING_IDS.theme)!.default).toBe('system');
  });

  it('gives every setting a unique device key, a default its validator accepts, and a decode of nothing that is the default', () => {
    const keys = new Map<string, string>();
    for (const def of SETTINGS.values()) {
      expect(def.validate(def.default), `${def.id} default`).toBe(true);
      if (def.scope === 'project') continue;
      const k = keyOf(def);
      expect(keys.get(k), `${def.id} shares ${k}`).toBeUndefined();
      keys.set(k, def.id);
      const empty = (def.codec ?? JSON_CODEC).decode(null);
      if (empty !== undefined) expect(empty, `${def.id} decode(null)`).toEqual(def.default);
    }
  });

  it('stores account settings under ids the server accepts', () => {
    for (const def of SETTINGS.values()) if (def.scope === 'account') expect(def.id, def.id).toMatch(PREF_KEY_RE);
  });

  it('gives every section a known id, and automatic settings only switches', () => {
    const sections = new Set(SECTIONS.map((s) => s.id));
    for (const def of CORE_SETTINGS) {
      expect(sections.has(def.section), def.id).toBe(true);
      if (def.automatic) expect(def.control.kind, def.id).toBe('switch');
      if (def.control.kind === 'segmented' || def.control.kind === 'select') {
        for (const o of def.control.options) expect(def.validate(o.value), `${def.id} option ${o.value}`).toBe(true);
      }
    }
  });

  it('offers the spellchecker’s own languages', () => {
    expect(SPELL_LANG_OPTIONS.map((l) => [l.value, l.label])).toEqual(SPELL_LANGS.map((l) => [l.id, l.label]));
  });

  it('offers interface sizes the pre-paint script knows', () => {
    expect([...UI_SCALES]).toEqual([90, 100, 110, 125]);
  });

  it('loads the shortcuts row’s control lazily', async () => {
    const def = settingDef(CORE_SETTING_IDS.shortcuts)!;
    expect(def.control.kind).toBe('custom');
    if (def.control.kind === 'custom') expect(typeof (await def.control.load()).default).toBe('function');
  });
});
