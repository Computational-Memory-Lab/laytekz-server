import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chord, KeybindingDef } from '../types';
import { chord, chordId, formatChord, sameChord } from '../chords';
import { reservationFor } from '../reserved';

// The keyboard plan (v2-plan §2.3), enforced on both platforms over the core
// bindings and every feature's. desktop-v2/tests/shell.spec.mjs mirrors the
// desktop half (no menu accelerator shadows a web chord).
vi.mock('../../settings/store', () => {
  const missing = () => { throw new Error('store not used here'); };
  return { getSetting: missing, setSetting: missing, resetSetting: missing, subscribeSetting: missing };
});
vi.mock('../../util/safeStorage', () => ({ safeStorage: { get: () => null, set: () => false, remove: () => {}, getJSON: <T,>(_k: string, f: T) => f, setJSON: () => false } }));

import { CORE_KEYBINDINGS, chordProblem, keybindings, registerKeybindings } from '../registry';
import { FEATURES } from '../../features/manifest';

const PLATFORMS = [true, false] as const;
const name = (mac: boolean) => (mac ? 'macOS' : 'Windows/Linux');

/** The plan's table: who may own each default, and in which scope. */
const PLANNED: readonly { action: string; chord: Chord; owners: readonly string[]; scope: KeybindingDef['scope'] | 'chain' | 'desktop' }[] = [
  { action: 'Settings', chord: chord('mod+,'), owners: ['settings'], scope: 'page' },
  { action: 'Insert citation', chord: chord('mod+shift+e'), owners: ['citations'], scope: 'page' },
  { action: 'Insert cross-reference', chord: chord('mod+shift+x'), owners: ['crossrefs'], scope: 'page' },
  { action: 'Narrative ⇄ parenthetical', chord: chord('mod+shift+ '), owners: ['citations'], scope: 'editor' },
  { action: 'Follow link', chord: chord('alt+Enter'), owners: ['follow'], scope: 'editor' },
  { action: 'Find references', chord: chord('alt+shift+Enter'), owners: ['crossrefs', 'citations', 'links'], scope: 'editor' },
  { action: 'Highlight selection', chord: chord('mod+shift+h'), owners: ['highlighter'], scope: 'page-capture' },
  { action: 'Insert statistic', chord: chord('mod+shift+u'), owners: ['stats'], scope: 'page' },
  { action: 'Align table', chord: chord('alt+shift+a', 'KeyA'), owners: ['tables'], scope: 'editor' },
  { action: 'Ask for a suggestion', chord: chord('alt+\\', 'Backslash'), owners: ['suggest'], scope: 'editor' },
  { action: 'Paste exactly as copied', chord: chord('mod+shift+v'), owners: ['escape'], scope: 'editor' },
  { action: 'Print the PDF', chord: chord('mod+p'), owners: ['outputs'], scope: 'page' },
];

/** Keys that belong to key chains or the menus, never to a binding. */
const NOT_BINDINGS: readonly Chord[] = [chord('Tab'), chord('shift+Tab'), chord('Escape'), chord('mod+ArrowRight'), chord('shift+F10', 'F10'), chord('ContextMenu')];

/** The desktop app's accelerators (plan §2.3); only the Settings binding, a 'native-menu' one, shares one. */
const DESKTOP_ACCELERATORS: readonly Chord[] = [
  chord('mod+r'), chord('mod+shift+r'), chord('mod+shift+i'), chord('mod+alt+i', 'KeyI'), chord('mod+0'), chord('mod+='), chord('mod+-'),
  chord('mod+m'), chord('mod+h'), chord('mod+alt+h', 'KeyH'), chord('mod+q'), chord('mod+w'), chord('mod+`'), chord('mod+,'),
];

/** Plan §2.3 "Rejected chords", for new bindings. */
const REJECTED: readonly Chord[] = [
  chord('mod+shift+l'), chord('mod+shift+c'), chord('mod+shift+i'), chord('mod+shift+j'),
  ...'abdnoprtw'.split('').map((k) => chord(`mod+shift+${k}`)),
  chord('mod+shift+['), chord('mod+shift+]'),
  chord('mod+alt+p', 'KeyP'), chord('mod+alt+2', 'Digit2'), chord('alt+e', 'KeyE'), chord('alt+shift+e', 'KeyE'),
];

const owner = (d: KeybindingDef) => (CORE_KEYBINDINGS.includes(d) ? d.id : d.id.split('.')[0]);
let all: readonly KeybindingDef[] = [];

beforeAll(() => {
  const features: KeybindingDef[] = [];
  for (const m of FEATURES) for (const d of m.keybindings ?? []) features.push(d);
  registerKeybindings(features);
  all = keybindings();
});

describe('keybinding defaults', () => {
  it('are registered for every feature that declares them, under its own id prefix', () => {
    for (const m of FEATURES) {
      for (const d of m.keybindings ?? []) {
        expect(d.id.startsWith(`${m.id}.`), `${d.id} belongs to ${m.id}`).toBe(true);
        expect(all, `${d.id} registered`).toContain(d);
      }
    }
  });

  for (const mac of PLATFORMS) {
    it(`never share keys on ${name(mac)}`, () => {
      const seen = new Map<string, string>();
      for (const d of all) {
        if (!d.default) continue;
        const id = chordId(d.default);
        expect(seen.get(id), `${formatChord(d.default, mac)}: ${d.id} and ${seen.get(id)}`).toBeUndefined();
        seen.set(id, d.id);
      }
    });

    it(`pass chordProblem on ${name(mac)}: none reserved, none typing, none taken twice`, () => {
      for (const d of all) if (d.default) expect(chordProblem(d.default, d.id, mac), `${d.id} on ${formatChord(d.default, mac)}`).toBeNull();
    });

    it(`take no reserved chord on ${name(mac)}, except comment's ⇧⌘C (README D7)`, () => {
      for (const d of all) {
        if (!d.default) continue;
        const r = reservationFor(d.default, mac);
        if (d.id === 'comment') { expect(r?.owner).toBe("the browser's developer tools"); continue; }
        expect(r, `${d.id} on ${formatChord(d.default, mac)} belongs to ${r?.owner}`).toBeNull();
      }
    });
  }

  it('keep Tab, Escape, ⌘→, Shift+F10 and the Menu key for key chains and menus', () => {
    for (const d of all) for (const c of NOT_BINDINGS) if (d.default) expect(sameChord(d.default, c), `${d.id} on ${formatChord(c)}`).toBe(false);
  });

  it('leave the desktop menu\'s accelerators alone; ⌘, is Settings, which the desktop menu owns there', () => {
    for (const d of all) {
      if (!d.default) continue;
      const shared = DESKTOP_ACCELERATORS.find((c) => sameChord(c, d.default!));
      if (!shared) continue;
      expect(d.id, `${d.id} on ${formatChord(shared)}`).toBe('settings');
      expect(d.desktop).toBe('native-menu');
    }
    expect(CORE_KEYBINDINGS.find((d) => d.id === 'settings')?.desktop).toBe('native-menu');
  });

  it('keep the five V1 shortcuts on their V1 defaults, comment on ⇧⌘C', () => {
    const v1 = Object.fromEntries(CORE_KEYBINDINGS.slice(0, 5).map((d) => [d.id, formatChord(d.default!, true)]));
    expect(v1).toEqual({ typeset: '⌘S', comment: '⇧⌘C', jump: '⌘J', palette: '⌘K', search: '⇧⌘F' });
  });
});

describe('the planned table', () => {
  for (const mac of PLATFORMS) {
    it(`has no row on a reserved, typing or doubled chord on ${name(mac)}`, () => {
      const seen = new Set<string>();
      for (const row of PLANNED) {
        expect(reservationFor(row.chord, mac), `${row.action} (${formatChord(row.chord, mac)})`).toBeNull();
        expect(seen.has(chordId(row.chord)), row.action).toBe(false);
        seen.add(chordId(row.chord));
      }
    });
  }

  it('gives each planned chord only to its owner', () => {
    for (const d of all) {
      if (!d.default) continue;
      const row = PLANNED.find((r) => sameChord(r.chord, d.default!));
      if (row) expect(row.owners, `${d.id} took ${row.action}'s ${formatChord(row.chord)}`).toContain(owner(d));
    }
  });

  it('keeps the core rows: Settings on ⌘, and Follow on Alt+Enter', () => {
    for (const id of ['settings', 'follow']) {
      const d = CORE_KEYBINDINGS.find((x) => x.id === id)!;
      const row = PLANNED.find((r) => r.owners.includes(id))!;
      expect(sameChord(d.default!, row.chord), id).toBe(true);
      expect(d.scope).toBe(row.scope);
    }
  });

  it('can still be recorded by its owners, Alt+Enter and Shift+Alt+Enter without ⌘', () => {
    for (const mac of PLATFORMS) {
      for (const row of PLANNED) {
        // The binding that has the chord once its feature lands; until then a stand-in of the owner's.
        const id = all.find((d) => d.default && sameChord(d.default, row.chord))?.id ?? `${row.owners[0]}.planned`;
        expect(chordProblem(row.chord, id, mac), `${row.action} on ${name(mac)}`).toBeNull();
      }
    }
  });
});

describe('rejected chords', () => {
  for (const mac of PLATFORMS) {
    it(`are refused for a new binding on ${name(mac)}`, () => {
      for (const c of REJECTED) expect(chordProblem(c, 'newfeature.action', mac), formatChord(c, mac)).not.toBeNull();
      if (mac) expect(chordProblem(chord('mod+shift+y'), 'newfeature.action', true)).toMatch(/Stickies/);
      for (const c of DESKTOP_ACCELERATORS) expect(chordProblem(c, 'newfeature.action', mac), formatChord(c, mac)).not.toBeNull();
    });
  }
});
