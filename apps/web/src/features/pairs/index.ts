import type { FeatureModule } from '../types';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import { deletePair, pairsExtension, splitDisplay, stepOut } from './pairs';
import { currencyRule } from './currency';
import { PAIRS_SETTINGS } from './settings';

const DEPS = [PAIRS_SETTINGS.brackets, PAIRS_SETTINGS.math, PAIRS_SETTINGS.quotes, PAIRS_SETTINGS.tabOut];

/** A switch is on unless the store says false (an unreadable store counts as on, like the auto-edit core). */
function on(read: () => unknown): boolean {
  try {
    return read() !== false;
  } catch {
    return true;
  }
}

/**
 * F12 auto-close pairs (WP12): wider bracket closing, `$`/`\(`/`\[`/`\{`/
 * `\left` and backtick pairs, typing over closers (completion braces too),
 * Backspace inside a new pair, Tab out of a closer, Enter inside `\[¦\]`, and
 * the `$5 ` currency guard. Each behaviour has its own switch under
 * Settings › Typing; with every switch off the editor types as Version 1 did.
 */
const feature: FeatureModule = {
  id: 'pairs',
  editor: {
    deps: DEPS,
    extension: (ctx) => pairsExtension({
      brackets: on(() => ctx.setting<boolean>(PAIRS_SETTINGS.brackets)),
      math: on(() => ctx.setting<boolean>(PAIRS_SETTINGS.math)),
      quotes: on(() => ctx.setting<boolean>(PAIRS_SETTINGS.quotes)),
      tabOut: on(() => ctx.setting<boolean>(PAIRS_SETTINGS.tabOut)),
    }, { visual: ctx.mode() === 'visual' }),
    keyChains: [
      { key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.closerStepOut, id: 'pairs.stepOut', run: stepOut },
      { key: 'Backspace', priority: KEY_CHAIN_PRIORITY.Backspace.multiCharPair, id: 'pairs.deletePair', run: deletePair },
      { key: 'Enter', priority: KEY_CHAIN_PRIORITY.Enter.displaySplit, id: 'pairs.splitDisplay', run: splitDisplay },
    ],
    autoEditRules: [currencyRule],
  },
};

export default feature;
