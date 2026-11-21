import type { AnySettingDef } from '../../settings/types';
import { MODEL_SETTINGS } from './model/settings'; // Galley: V2 (WP43) "Smarter suggestions (experimental)"

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** The ids, for the feature and its tests. */
export const SUGGEST_SETTINGS = {
  words: 'suggest.words',
} as const;

/**
 * The 'suggest.*' settings (WP40; WP43 adds the model's). Pure data: import
 * types only, never the store or UI code. The word ghost is an automatic
 * behaviour: on by default, off under the legacy specs' 'automatic-off'.
 */
export const settings: readonly AnySettingDef[] = [
  {
    id: SUGGEST_SETTINGS.words,
    section: 'completion',
    label: 'Inline word suggestions',
    hint: 'While you type a long word this project already uses, the rest of it appears in grey after the caret. Tab accepts it and Escape hides it. Made on this device from your own files; nothing is sent anywhere.',
    keywords: 'inline suggestion ghost text grey tab complete word autocomplete predict vocabulary',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 20,
    palette: true,
  },
  ...MODEL_SETTINGS, // Galley: V2 (WP43)
];
