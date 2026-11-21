import { describe, expect, it } from 'vitest';
import { fallbackShape, parsePetAsset, petAssetFrom, petImageUrl, petSqueakUrl, scanAlpha } from '../asset';
import {
  AWAY_KEY, AWAY_MS, DEFAULT_PET_PREFS, PET_SETTINGS, awayMessage, bringBack, parseAwayUntil, petAvailable, petPrefsFrom,
  readAwayUntil, sendAway,
} from '../prefs';
import { PREF_KEY_RE } from '../../../../settings/types';

describe('asset', () => {
  it('accepts a well-formed capability and refuses hostile values', () => {
    expect(parsePetAsset({ v: '0123456789ab', w: 191, h: 178, s: null })).toEqual({ v: '0123456789ab', w: 191, h: 178, s: null, q: null });
    expect(parsePetAsset({ v: '0123456789ab', w: -1, h: 'x', s: '../../etc', q: '<audio>' })).toEqual({ v: '0123456789ab', w: null, h: null, s: null, q: null });
    for (const bad of [null, 'x', [], {}, { v: 'not-hex-at-all' }, { v: '0123456789AB' }, { v: '"><script>' }]) expect(parsePetAsset(bad)).toBeNull();
    expect(petAssetFrom({ rev: '', pet: { v: 'abcdefabcdef' } })?.v).toBe('abcdefabcdef');
    expect(petAssetFrom({ rev: '' })).toBeNull();
  });
  it('builds versioned URLs, the squeak only when the server has a recording', () => {
    const a = parsePetAsset({ v: 'abcdefabcdef', s: '0123456789ab', q: 'fedcba987654' })!;
    expect(petImageUrl(a)).toBe('/api/instance/pet?v=abcdefabcdef');
    expect(petImageUrl(a, 'silhouette')).toBe('/api/instance/pet/silhouette?v=0123456789ab');
    expect(petImageUrl({ ...a, s: null }, 'silhouette')).toBeNull();
    expect(petSqueakUrl(a)).toBe('/api/instance/pet/squeak?v=fedcba987654');
    expect(petSqueakUrl({ ...a, q: null })).toBeNull();
  });
  it('finds the figure from the transparency', () => {
    const w = 4, h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (const y of [2, 3, 7]) data[(y * w + 1) * 4 + 3] = 255;
    expect(scanAlpha(data, w, h)).toEqual({ top: 0.2, bottom: 0.8 });
    expect(scanAlpha(new Uint8ClampedArray(w * h * 4), w, h)).toEqual({ top: 0, bottom: 1 });
    expect(fallbackShape({ v: 'abcdefabcdef', w: 200, h: 100, s: null, q: null })).toEqual({ aspect: 2, top: 0, bottom: 1, naturalHeight: 100 });
  });
});

describe('prefs', () => {
  it('off by default, squeaking when on, comments off and the other reactions on', () => {
    expect(DEFAULT_PET_PREFS.on).toBe(false);
    expect(DEFAULT_PET_PREFS.squeak).toBe(true);
    expect(DEFAULT_PET_PREFS.reactions).toEqual({ typeset: true, joins: true, comments: false, doze: true });
  });
  it('every setting follows the account, in the pet section, with a valid id and default', () => {
    for (const d of PET_SETTINGS) {
      expect(d.id.startsWith('pet.')).toBe(true);
      expect(PREF_KEY_RE.test(d.id)).toBe(true);
      expect(d.scope).toBe('account');
      expect(d.section).toBe('pet');
      expect(d.validate(d.default)).toBe(true);
    }
    expect(new Set(PET_SETTINGS.map((d) => d.id)).size).toBe(PET_SETTINGS.length);
  });
  it('has "Squeak when clicked" and none of the first pet\'s spot and wandering options', () => {
    const ids = PET_SETTINGS.map((d) => d.id);
    const squeak = PET_SETTINGS.find((d) => d.id === 'pet.squeak');
    expect(squeak?.label).toBe('Squeak when clicked');
    expect(squeak?.default).toBe(true);
    for (const gone of ['pet.perch', 'pet.react.errors', 'pet.react.wander']) expect(ids).not.toContain(gone);
  });
  it('the settings appear only when the server offers a pet', () => {
    const env = (capabilities: Record<string, unknown>) => ({ accounts: true, signedIn: true, desktop: false, phone: false, project: null, capabilities: { rev: '', accounts: true, prefs: true, mcp: false, oauthRegistration: false, ...capabilities } });
    const on = PET_SETTINGS[0];
    expect(on.visible!(env({}))).toBe(false);
    expect(on.visible!(env({ pet: { v: 'abcdefabcdef' } }))).toBe(true);
    expect(petAvailable({ capabilities: { rev: '', accounts: false, prefs: false, mcp: false, oauthRegistration: false, pet: 'x' } })).toBe(false);
  });
  it('falls back field by field for junk', () => {
    const values: Record<string, unknown> = { 'pet.on': true, 'pet.activity': 'wild', 'pet.size': 'small', 'pet.squeak': 'loud', 'pet.react.comments': 'yes', 'pet.react.doze': false };
    const p = petPrefsFrom((id) => values[id]);
    expect(p).toEqual({ on: true, activity: 'calm', size: 'small', squeak: true, reactions: { ...DEFAULT_PET_PREFS.reactions, doze: false } });
    expect(petPrefsFrom(() => { throw new Error('store not ready'); })).toEqual(DEFAULT_PET_PREFS);
  });
  it('"away until" is per device, and a past or junk value means visible', () => {
    const map = new Map<string, string>();
    const store = { get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => { map.set(k, v); return true; }, remove: (k: string) => { map.delete(k); } };
    const now = Date.UTC(2026, 10, 21, 14, 42);
    expect(readAwayUntil(store, now)).toBeNull();
    const until = sendAway(store, now);
    expect(until).toBe(now + AWAY_MS);
    expect(map.get(AWAY_KEY)).toBe(String(until));
    expect(readAwayUntil(store, now + 1000)).toBe(until);
    expect(readAwayUntil(store, until + 1)).toBeNull();
    bringBack(store);
    expect(readAwayUntil(store, now)).toBeNull();
    expect(parseAwayUntil('soon', now)).toBeNull();
    expect(parseAwayUntil(String(now + 5 * AWAY_MS), now)).toBeNull();
    expect(awayMessage(until, 'en-GB')).toMatch(/^The desk pet is away until \d\d:\d\d\.$/);
  });
});
