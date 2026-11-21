import type { CustomControlProps } from '../types';
import type { ShortcutOverrides as Overrides } from '../codecs';

/**
 * The generic control of `keys.shortcuts`: how many shortcuts differ from
 * their defaults, and a way back. The Shortcuts section records chords with
 * its own rows (the keybinding registry); this stands in wherever a page
 * renders the setting generically.
 */
export default function ShortcutOverrides({ value, onChange, disabled }: CustomControlProps<Overrides>) {
  const changed = Object.keys(value ?? {}).length;
  return (
    <span className="settings-shortcuts-summary" data-testid="setting-control-keys-shortcuts">
      <span>{changed === 0 ? 'All shortcuts use their defaults' : changed === 1 ? '1 shortcut changed' : `${changed} shortcuts changed`}</span>
      {changed > 0 && (
        <button type="button" className="btn btn--ghost btn--small" disabled={disabled} onClick={() => onChange({})} data-testid="setting-reset-keys-shortcuts">
          Reset shortcuts
        </button>
      )}
    </span>
  );
}
