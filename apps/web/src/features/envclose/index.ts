import type { Extension } from '@codemirror/state';
import type { FeatureModule } from '../types';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import { autoEditCore } from '../../editor/core/autoEdit';
import { envCloseOwned } from '../../editor/beginEnv';
import { envCloseConfig, type EnvCloseConfig } from './config';
import { argJump, argSlotExtension, closeRule, enterClose } from './close';
import { envSyncExtension } from './envSync';
import { envCompletionFilter } from './completion';
import { leaveFields, nextField, prevField } from './fields';
import { ENVCLOSE_SETTINGS } from './settings';

/** A switch is on unless the store says false (an unreadable store counts as on, like the auto-edit core). */
function on(read: () => unknown): boolean {
  try {
    return read() !== false;
  } catch {
    return true;
  }
}

/** Below the `\[¦\]` split and the argument jump (90), above plain Enter. */
const ENTER_CLOSE_PRIORITY = KEY_CHAIN_PRIORITY.Enter.displaySplit - 1;

export function envCloseExtension(cfg: Omit<EnvCloseConfig, 'on'>): Extension {
  return [
    envCloseOwned.of(true),
    envCloseConfig.of({ ...cfg, on: true }),
    autoEditCore([]),
    argSlotExtension,
    cfg.linked ? envSyncExtension : [],
  ];
}

/**
 * F12 closing environments, linked names and tab stops (WP31). One closer
 * (editor/beginEnv.ts planEnvClose) serves the `}` of `\begin{name}`, Enter
 * at the end of a \begin line and environment completions, and never adds a
 * second \end; the \end block is its own undo step, and Backspace right
 * after takes it back. Editing a \begin or \end name renames its partner in
 * the same transaction. Commands with several arguments complete with tab
 * stops. Each part has its own switch under Settings › Typing.
 */
const feature: FeatureModule = {
  id: 'envclose',
  editor: {
    files: /\.(tex|ltx|sty|cls|dtx)$/i,
    deps: [ENVCLOSE_SETTINGS.close, ENVCLOSE_SETTINGS.linked, ENVCLOSE_SETTINGS.tabStops],
    extension: (ctx) => envCloseExtension({
      close: on(() => ctx.setting<boolean>(ENVCLOSE_SETTINGS.close)),
      linked: on(() => ctx.setting<boolean>(ENVCLOSE_SETTINGS.linked)),
      tabStops: on(() => ctx.setting<boolean>(ENVCLOSE_SETTINGS.tabStops)),
      visual: ctx.mode() === 'visual',
    }),
    keyChains: [
      { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.fields, id: 'envclose.nextField', run: nextField },
      { key: 'Shift-Tab', priority: KEY_CHAIN_PRIORITY.Tab.fields, id: 'envclose.prevField', run: prevField },
      { key: 'Escape', priority: KEY_CHAIN_PRIORITY.Escape.fields, id: 'envclose.leaveFields', run: leaveFields },
      { key: 'Enter', priority: KEY_CHAIN_PRIORITY.Enter.displaySplit, id: 'envclose.argJump', run: argJump },
      { key: 'Enter', priority: ENTER_CLOSE_PRIORITY, id: 'envclose.enterClose', run: enterClose },
    ],
    autoEditRules: [closeRule],
    completionFilter: envCompletionFilter,
  },
};

export default feature;
