/**
 * The Keyboard shortcuts section (WP23): every keybinding the app and its
 * features registered (keys/registry.ts), grouped, each with its keys, a
 * recorder, None (unbound) and Reset; then the keys that cannot be changed.
 * The V1 test ids stay: `settings-shortcuts`, `shortcut-<id>`,
 * `shortcut-reset-<id>`, `shortcut-hint-<id>`.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { KeybindingDef } from '../../keys/types';
import { chordConflict, chordFor, chordLabel, chordProblem, isOverridden, keybindings, setChord, subscribeKeybindings, useChordLabel } from '../../keys/registry';
import { chord, chordFromEvent, formatChord, sameChord } from '../../keys/chords';
import { TYPESET_ENTER } from '../../util/shortcuts';
import { matches } from './search';

/** Keys the editor keeps, shown for reference. */
export const FIXED_KEYS: readonly { label: string; keys: string }[] = [
  { label: 'Typeset, as well', keys: formatChord(TYPESET_ENTER) },
  { label: 'Find in the file', keys: formatChord(chord('mod+f')) },
  { label: 'Format the document', keys: formatChord(chord('shift+alt+f')) },
  { label: 'Bold and italic', keys: `${formatChord(chord('mod+b'))}  ${formatChord(chord('mod+i'))}` },
  { label: 'Undo and redo', keys: `${formatChord(chord('mod+z'))}  ${formatChord(chord('mod+shift+z'))}` },
  { label: 'Accept a completion', keys: 'Tab' },
  { label: 'Open the editor’s menu', keys: formatChord(chord('shift+F10')) },
];

const allBindings = () => keybindings();

export function useKeybindings(): readonly KeybindingDef[] {
  return useSyncExternalStore(subscribeKeybindings, allBindings, allBindings);
}

/** What the search looks at for a binding. */
export function bindingMatches(query: string, d: KeybindingDef): boolean {
  return !query.trim() || matches(query, d.label, `${d.group} ${chordLabel(d.id)}`);
}

/** The words the page's search counts for this section. */
export function shortcutTerms(defs: readonly KeybindingDef[]): string[] {
  return [...defs.map((d) => d.label), ...FIXED_KEYS.map((k) => k.label)];
}

export function ShortcutsSection({ query, desktop, scopeName }: { query: string; desktop: boolean; scopeName: string }) {
  const defs = useKeybindings();
  const shown = defs.filter((d) => bindingMatches(query, d));
  const groups: { name: string; items: KeybindingDef[] }[] = [];
  for (const d of shown) {
    const g = groups.find((x) => x.name === d.group);
    if (g) g.items.push(d); else groups.push({ name: d.group, items: [d] });
  }
  const fixed = FIXED_KEYS.filter((k) => !query.trim() || matches(query, k.label, k.keys));
  return (
    <div data-testid="settings-shortcuts" data-setting-row="keys.shortcuts">
      <p className="settings__hint settings-page__note">
        Saved {scopeName === 'Your account' ? 'to your account' : 'in this browser'}. Click the keys, then press new ones. None leaves a command without keys.
      </p>
      {groups.map((g) => (
        <div key={g.name} className="settings-keys__group" data-testid={`shortcut-group-${g.name}`}>
          <div className="menu__label settings__heading">{g.name}</div>
          {g.items.map((d) => <BindingRow key={d.id} def={d} desktop={desktop} />)}
        </div>
      ))}
      {fixed.length > 0 && (
        <div className="settings-keys__group">
          <div className="menu__label settings__heading">Keys that stay the same</div>
          <dl className="settings-keys__fixed" data-testid="settings-fixed-keys">
            {fixed.map((k) => (
              <div key={k.label} className="settings-keys__fixed-row">
                <dt>{k.label}</dt>
                <dd><kbd className="kbd">{k.keys}</kbd></dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/** One binding: click the keys, press new ones; Esc keeps the old ones. */
function BindingRow({ def, desktop }: { def: KeybindingDef; desktop: boolean }) {
  const id = def.id;
  const keys = useChordLabel(id);
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const stop = () => { setRecording(false); setProblem(null); };
  useEffect(() => {
    if (!recording) return;
    // Window capture runs before the page's Escape and the editor's own
    // shortcuts, so the chord being recorded does nothing else. Keyup too:
    // Space would otherwise click the button on release.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) { stop(); return; }
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keyup') return;
      if (e.key === 'Escape') { stop(); return; }
      const c = chordFromEvent(e);
      if (!c) return;
      const why = chordProblem(c, id);
      if (why) { setProblem(why); return; }
      setChord(id, c);
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [recording, id]);

  const clash = recording ? null : chordConflict(id);
  // V1's words, which spec 45 reads.
  const clashHint = clash ? `${keys} is also ${clash} — change one of them` : null;
  const native = desktop && def.desktop === 'native-menu' ? 'The desktop app’s menu answers these keys' : null;
  // Typeset's second keys, unless another binding took them.
  const enter = id === 'typeset' && !keybindings().some((d) => { const c = chordFor(d.id); return !!c && sameChord(c, TYPESET_ENTER); })
    ? `${formatChord(TYPESET_ENTER)} typesets too` : null;
  const hint = problem ?? clashHint ?? (recording ? 'Press the new keys · Esc keeps these' : !def.changeable ? 'Can’t be changed' : native ?? enter);
  const error = !!(problem || clashHint);
  const label = keys || 'None';

  return (
    <div className="settings__row settings-keys__row" data-setting-row={`shortcut.${id}`}>
      <div className="settings__text">
        <span className="settings__label" id={`shortcut-label-${id}`}>{def.label}</span>
        {hint && <span className={`settings__hint${error ? ' settings__hint--error' : ''}`} data-testid={`shortcut-hint-${id}`}>{hint}</span>}
      </div>
      <div className="settings__control settings-keys__control">
        {def.changeable ? (
          <button
            type="button"
            className={`input shortcut${recording ? ' is-recording' : ''}`}
            onClick={() => (recording ? stop() : setRecording(true))}
            onBlur={stop}
            aria-label={`${def.label}: ${label}. Press to change`}
            data-testid={`shortcut-${id}`}
          >
            {recording ? 'Press keys…' : keys ? <kbd className="kbd">{keys}</kbd> : <span className="settings-keys__none">None</span>}
          </button>
        ) : (
          <span className="settings__value" data-testid={`shortcut-${id}`}>{keys ? <kbd className="kbd">{keys}</kbd> : 'None'}</span>
        )}
        {def.changeable && keys && (
          <button type="button" className="btn btn--small" onClick={() => setChord(id, null)} title="Leave this command without keys" data-testid={`shortcut-none-${id}`}>None</button>
        )}
        {def.changeable && isOverridden(id) && (
          <button type="button" className="btn btn--small shortcut__reset" onClick={() => setChord(id, def.default)} title="Use the default keys" data-testid={`shortcut-reset-${id}`}>Reset</button>
        )}
      </div>
    </div>
  );
}
