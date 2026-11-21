/**
 * F14 desk pet: preferences (WP39 pet-engine; roaming pet: PET2). Pure data
 * and functions, no React, no store import: `features/pet/settings.ts`
 * exports PET_SETTINGS as its `settings`, and the runtime reads them through
 * `petPrefsFrom(getSetting)`.
 *
 * Every preference follows the account (scope 'account'), except "away
 * until", which is this device's alone: sending the pet away on a laptop
 * should not hide it on the office desktop. It is a plain device key, synced
 * across this browser's tabs by the `storage` event.
 *
 * Settings of the first pet that no longer apply ('pet.perch',
 * 'pet.react.errors', 'pet.react.wander') are simply not read any more; a
 * stored value is harmless.
 */
import type { AnySettingDef, SettingsEnv } from '../../../settings/types';

export type PetActivity = 'calm' | 'playful';
export type PetSize = 'normal' | 'small';
export type PetReaction = 'typeset' | 'joins' | 'comments' | 'doze';

export interface PetPrefs {
  on: boolean;
  activity: PetActivity;
  size: PetSize;
  /** Play the squeak when the pet is clicked. */
  squeak: boolean;
  reactions: Record<PetReaction, boolean>;
}

export const PET_REACTIONS: readonly PetReaction[] = ['typeset', 'joins', 'comments', 'doze'];

export const DEFAULT_PET_PREFS: PetPrefs = {
  on: false,
  activity: 'calm',
  size: 'normal',
  squeak: true,
  reactions: { typeset: true, joins: true, comments: false, doze: true },
};

/** The setting id of each preference (also its account preference key). */
export const PET_IDS = {
  on: 'pet.on',
  activity: 'pet.activity',
  size: 'pet.size',
  squeak: 'pet.squeak',
  reaction: (r: PetReaction) => `pet.react.${r}`,
} as const;

const oneOf = <T extends string>(values: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isActivity = oneOf<PetActivity>(['calm', 'playful']);
const isSize = oneOf<PetSize>(['normal', 'small']);

/** The operator supplied an image this caller may see (the server sends `pet` only then). */
export function petAvailable(env: Pick<SettingsEnv, 'capabilities'>): boolean {
  const p = (env.capabilities as Record<string, unknown> | undefined)?.pet;
  return !!p && typeof p === 'object' && typeof (p as { v?: unknown }).v === 'string';
}

const REACTION_LABELS: Record<PetReaction, { label: string; hint: string }> = {
  typeset: { label: 'React to typesetting', hint: 'Looks at the PDF while it typesets, hops when it works and shakes when it fails.' },
  joins: { label: 'Notice when someone joins', hint: 'A short wobble when a collaborator opens the project.' },
  comments: { label: 'Notice new comments', hint: 'Perks up when someone else comments.' },
  doze: { label: 'Nap when I am away', hint: 'Naps after a few minutes without input and wakes up when you move the mouse.' },
};

const visible = (env: SettingsEnv) => petAvailable(env);

/** The 'pet.*' setting definitions, in the 'pet' section, shown only when the server offers a pet. */
export const PET_SETTINGS: readonly AnySettingDef[] = [
  {
    id: PET_IDS.on, section: 'pet', label: 'Desk pet', scope: 'account', default: false, validate: isBool,
    control: { kind: 'switch' }, palette: true, visible, order: 10, keywords: 'pet companion mascot duck',
    hint: 'A small pet that hops around the window and reacts to what you do. Drag it to move it, click it to squeak. Only you see it.',
  },
  {
    id: PET_IDS.activity, section: 'pet', label: 'Activity', scope: 'account', default: 'calm', validate: isActivity,
    control: { kind: 'segmented', options: [{ value: 'calm', label: 'Calm' }, { value: 'playful', label: 'Playful' }] },
    hint: 'Playful hops around more often.',
    dependsOn: PET_IDS.on, visible, order: 20,
  },
  {
    id: PET_IDS.size, section: 'pet', label: 'Size', scope: 'account', default: 'normal', validate: isSize,
    control: { kind: 'segmented', options: [{ value: 'normal', label: 'Normal' }, { value: 'small', label: 'Small' }] },
    dependsOn: PET_IDS.on, visible, order: 30,
  },
  {
    id: PET_IDS.squeak, section: 'pet', label: 'Squeak when clicked', scope: 'account', default: true, validate: isBool,
    control: { kind: 'switch' }, keywords: 'sound duck squeak audio',
    dependsOn: PET_IDS.on, visible, order: 40,
  },
  ...PET_REACTIONS.map((r, i): AnySettingDef => ({
    id: PET_IDS.reaction(r), section: 'pet', label: REACTION_LABELS[r].label, hint: REACTION_LABELS[r].hint,
    scope: 'account', default: DEFAULT_PET_PREFS.reactions[r], validate: isBool, control: { kind: 'switch' },
    dependsOn: PET_IDS.on, visible, order: 50 + i,
  })),
];

/** The preferences from a setting getter (the store's getSetting), each field
 *  checked on its own: a junk value falls back to that field's default only. */
export function petPrefsFrom(get: (id: string) => unknown): PetPrefs {
  const read = <T>(id: string, ok: (v: unknown) => v is T, fallback: T): T => {
    let v: unknown;
    try { v = get(id); } catch { return fallback; }
    return ok(v) ? v : fallback;
  };
  const reactions = {} as Record<PetReaction, boolean>;
  for (const r of PET_REACTIONS) reactions[r] = read(PET_IDS.reaction(r), isBool, DEFAULT_PET_PREFS.reactions[r]);
  return {
    on: read(PET_IDS.on, isBool, DEFAULT_PET_PREFS.on),
    activity: read(PET_IDS.activity, isActivity, DEFAULT_PET_PREFS.activity),
    size: read(PET_IDS.size, isSize, DEFAULT_PET_PREFS.size),
    squeak: read(PET_IDS.squeak, isBool, DEFAULT_PET_PREFS.squeak),
    reactions,
  };
}

/** Every setting id the runtime must watch (subscribeSetting). */
export const PET_SETTING_IDS: readonly string[] = PET_SETTINGS.map((d) => d.id);

// ---- "Away until": this device only ----

/** localStorage key: epoch milliseconds, or absent. Device keys keep the `aldine.` prefix. */
export const AWAY_KEY = 'aldine.pet.awayUntil';
export const AWAY_MS = 60 * 60 * 1000;

/** The stored value as a time still in the future, or null (absent, junk or past: visible). */
export function parseAwayUntil(raw: string | null, now: number): number | null {
  if (raw === null) return null;
  const t = Number(raw);
  if (!Number.isFinite(t) || t <= now) return null;
  // A value more than an hour and a minute ahead was not written by this app (clock change, tampering).
  return t - now > AWAY_MS + 60_000 ? null : t;
}

/** "15:42" in the person's own clock format. */
export function clockLabel(t: number, locale?: string): string {
  try {
    return new Date(t).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/** The toast after sending the pet away. */
export function awayMessage(until: number, locale?: string): string {
  return `The desk pet is away until ${clockLabel(until, locale)}.`;
}

/** Minimal storage the away helpers need (util/safeStorage's `safeStorage` fits). */
export interface AwayStore { get(key: string): string | null; set(key: string, value: string): boolean; remove(key: string): void }

export function readAwayUntil(store: AwayStore, now: number): number | null {
  return parseAwayUntil(store.get(AWAY_KEY), now);
}

/** Sends the pet away for an hour from `now`; returns the time it comes back. */
export function sendAway(store: AwayStore, now: number): number {
  const until = now + AWAY_MS;
  store.set(AWAY_KEY, String(until));
  return until;
}

export function bringBack(store: AwayStore): void {
  store.remove(AWAY_KEY);
}
