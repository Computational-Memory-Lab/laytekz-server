import { describe, expect, it } from 'vitest';
import {
  appearanceCodec, editorModeCodec, jsonCodec, layoutCodec, offUnless1, onUnless0, parseAppearance, pdfZoomCodec,
  sameValue, shortcutsCodec, spellLangCodec,
} from '../codecs';
import { SPELL_LANGS, spellLangKnown } from '../../editor/spellcheck';

/**
 * Each V1 key, read exactly as the V1 code read it (pages/Editor.tsx,
 * util/layout.ts, util/shortcuts.ts, editor/spellcheck.ts, theme.ts): the V1
 * expression on the left, the codec on the right, for absent, '0', '1', ''
 * and junk.
 */
const SAMPLES: (string | null)[] = [null, '0', '1', '', 'junk', 'true', 'false', ' 1', '00', 'null', '{}'];

describe('legacy codecs read every stored text exactly as V1 did', () => {
  it('aldine.autoTypeset, aldine.draftTypeset, aldine.spellcheck, aldine.changeMarks: on unless "0"', () => {
    for (const raw of SAMPLES) expect(onUnless0.decode(raw), String(raw)).toBe(raw !== '0');
  });

  it('aldine.vim and aldine.experimental.agentPresence: off unless "1"', () => {
    for (const raw of SAMPLES) expect(offUnless1.decode(raw), String(raw)).toBe(raw === '1');
  });

  it('write the texts V1 wrote', () => {
    expect([onUnless0.encode(true), onUnless0.encode(false)]).toEqual(['1', '0']);
    expect([offUnless1.encode(true), offUnless1.encode(false)]).toEqual(['1', '0']);
  });

  it('aldine.theme: light, dark or system; anything else follows the system', () => {
    for (const raw of [...SAMPLES, 'light', 'dark', 'system', 'Dark', 'sepia']) {
      const v1 = raw === 'light' || raw === 'system' || raw === 'dark' ? raw : 'system';
      expect(appearanceCodec.decode(raw), String(raw)).toBe(v1);
      expect(parseAppearance(raw)).toBe(v1);
    }
    expect(parseAppearance(undefined)).toBe('system');
  });

  it('aldine.editorMode: visual only for "visual"', () => {
    for (const raw of [...SAMPLES, 'visual', 'source', 'Visual']) {
      expect(editorModeCodec.decode(raw), String(raw)).toBe(raw === 'visual' ? 'visual' : 'source');
    }
  });

  it('aldine.layout: editor, both or pdf; anything else lets the width decide', () => {
    for (const raw of [...SAMPLES, 'editor', 'both', 'pdf', 'sideways']) {
      const v1 = raw === 'editor' || raw === 'both' || raw === 'pdf' ? raw : null;
      expect(layoutCodec.decode(raw), String(raw)).toBe(v1 ?? '');
    }
    expect(layoutCodec.encode('')).toBeNull();
    expect(layoutCodec.encode('pdf')).toBe('pdf');
  });

  it('aldine.pdfZoom: Number(text) between 0.5 and 3, otherwise 1', () => {
    for (const raw of [...SAMPLES, '0.5', '3', '3.01', '0.49', '1.25', 'NaN', '-1', '2e0']) {
      const z = Number(raw);
      expect(pdfZoomCodec.decode(raw), String(raw)).toBe(z >= 0.5 && z <= 3 ? z : 1);
    }
  });

  it('aldine.spellcheckLang: a known tag, otherwise the browser default', () => {
    const codec = spellLangCodec(spellLangKnown);
    for (const raw of [...SAMPLES, 'en-GB', 'de-DE', 'xx-XX', 'en-gb']) {
      expect(codec.decode(raw), String(raw)).toBe(spellLangKnown(raw) ? raw : '');
    }
    expect(codec.encode('')).toBeNull();
    expect(codec.encode('fr-FR')).toBe('fr-FR');
    expect(SPELL_LANGS.length).toBeGreaterThan(5);
  });

  it('aldine.shortcuts: the well-formed chords, and nothing for unreadable text', () => {
    const typeset = { mod: true, shift: true, alt: false, key: 'y', code: 'KeyY' };
    expect(shortcutsCodec.decode(null)).toEqual({});
    expect(shortcutsCodec.decode('junk')).toEqual({});
    expect(shortcutsCodec.decode('[1,2]')).toEqual({});
    expect(shortcutsCodec.decode('null')).toEqual({});
    expect(shortcutsCodec.decode(JSON.stringify({ typeset, jump: { mod: 'yes' }, search: null }))).toEqual({ typeset, search: null });
    expect(shortcutsCodec.decode(shortcutsCodec.encode({ typeset })!)).toEqual({ typeset });
  });
});

describe('the JSON codec of new settings', () => {
  it('reads nothing from absent, unparsable or refused text', () => {
    const c = jsonCodec((v): v is number => typeof v === 'number');
    expect(c.decode(null)).toBeUndefined();
    expect(c.decode('{')).toBeUndefined();
    expect(c.decode('"12"')).toBeUndefined();
    expect(c.decode('12')).toBe(12);
    expect(c.encode(12)).toBe('12');
  });
});

describe('sameValue', () => {
  it('compares JSON shapes, ignoring undefined members', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({}, [])).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue(NaN, NaN)).toBe(true);
  });
});
