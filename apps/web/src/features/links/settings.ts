import type { AnySettingDef } from '../../settings/types';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** The ids, for the feature and its tests. */
export const LINKS_SETTINGS = {
  follow: 'links.follow',
  project: 'links.project',
  menu: 'links.menu',
} as const;

/**
 * The 'links.*' settings (WP20). Pure data: import types only, never the
 * store or UI code. None of them changes the text: they decide what a
 * ⌘/Ctrl-click and a right-click on a link do. With "links.follow" off a
 * ⌘/Ctrl-click adds a cursor everywhere, as in Version 1.
 */
export const settings: readonly AnySettingDef[] = [
  {
    id: LINKS_SETTINGS.follow,
    section: 'editor-behaviour',
    label: 'Open links with ⌘-click or Ctrl-click',
    hint: 'Hold ⌘ (Ctrl on Windows and Linux) to underline web addresses, \\url, \\href, DOIs and arXiv ids; click to open them in the browser. Alt+Enter opens the link at the cursor. Off: the click adds a cursor, as before.',
    keywords: 'link url href doi arxiv orcid command click control click open browser follow',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 40,
    palette: true,
  },
  {
    id: LINKS_SETTINGS.project,
    section: 'editor-behaviour',
    label: 'Follow ⌘-click into files, labels and citations',
    hint: '\\input and \\includegraphics open the file, a \\ref key goes to its \\label, a citation key opens its .bib entry, and a \\label finds its references.',
    keywords: 'go to definition find references input include label ref cite bib jump',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    dependsOn: LINKS_SETTINGS.follow,
    order: 41,
  },
  {
    id: LINKS_SETTINGS.menu,
    section: 'editor-behaviour',
    label: 'Link items in the right-click menu',
    hint: 'Right-click a link for Open link and Copy link address, or Go to definition and Find references. Shift+right-click always shows the browser\'s own menu.',
    keywords: 'context menu right click open link copy link address',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 42,
  },
];
