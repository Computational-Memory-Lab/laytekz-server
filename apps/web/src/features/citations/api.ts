/**
 * The citations feature's public surface (WP19), for other features (WP26's
 * cross-reference picker reuses the picker shell). Import only from here.
 */
import { lazy } from 'react';

/** The shared keyboard picker, loaded on first use. Props: PickerShellProps. */
export const PickerShell = lazy(() => import('./PickerShell'));
export type { PickerShellProps, PickerRow, PickerChip } from './PickerShell';

export {
  buildCitation, citationFor, commandFor, detectFamilyIn, escapeNote, formatLocator, minimalChange,
  parseCitationAt, toggledCommand, atSentenceStart, wantsSpaceBefore,
} from './citeCommands';
export type { CiteFamily, CiteStyle, LocatorKind, ParsedCitation, CitationSpec } from './citeCommands';
export { cachedSetup, loadSetup, onSetup, type CiteSetup } from './refIndex';
export { documentFamily } from './actions';
