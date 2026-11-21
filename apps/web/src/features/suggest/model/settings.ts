/**
 * The "Smarter suggestions (experimental)" setting (WP43). Device scope: the
 * model is downloaded per browser, so turning it on in one browser must never
 * start a download in another. Off by default; the row's own control does
 * the download, shows its progress, and offers Cancel and Remove. Pure data
 * apart from the lazily loaded control.
 */
import type { AnySettingDef } from '../../../settings/types';
import { MODEL, megabytes } from './manifest';

export const MODEL_SETTING = 'suggest.model';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export const MODEL_SETTINGS: readonly AnySettingDef[] = [
  {
    id: MODEL_SETTING,
    section: 'completion',
    label: 'Smarter suggestions (experimental)',
    hint: `Suggests the next few words in grey, using a small language model (${MODEL.label}). Turning this on downloads it once (${megabytes(MODEL.bytes)}) from Hugging Face. The model runs on this computer, and nothing you type leaves it. Suggestions may be slow or odd on some computers. Word suggestions keep working without it.`,
    keywords: 'model language ai llm granite smarter tab complete next words predict download experimental offline',
    scope: 'device',
    default: false,
    validate: isBool,
    control: { kind: 'custom', load: () => import('./ModelControl') },
    dependsOn: 'suggest.words',
    order: 21,
  },
];
