import type { FeatureModule } from '../types';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import { mathCompletionFilter, tabOutOfMath } from './editor';
import { DEFAULT_CONFIG, autoMathExtension, identifierRule, wrapRule } from './rules';
import { AUTO_MATH_SETTING_IDS, DELIMITER_CHOICES, type DelimiterChoice } from './settings';

/**
 * F2 automatic math mode (WP11): a math word becomes inline math when it
 * ends (`x_i ` → `$x_i$ `), a name gets `\_` (`my_var` → `my\_var`), Tab
 * leaves inline math, and completion ranks math commands first in math.
 * Every change is one undo step and Backspace right after reverts it.
 */
const feature: FeatureModule = {
  id: 'automath',
  editor: {
    deps: [AUTO_MATH_SETTING_IDS.delimiter, AUTO_MATH_SETTING_IDS.tabOut],
    extension: (ctx) => {
      const delimiter = ctx.setting<DelimiterChoice>(AUTO_MATH_SETTING_IDS.delimiter);
      return autoMathExtension({
        delimiter: DELIMITER_CHOICES.includes(delimiter) ? delimiter : DEFAULT_CONFIG.delimiter,
        tabOut: ctx.setting<boolean>(AUTO_MATH_SETTING_IDS.tabOut) !== false,
      });
    },
    autoEditRules: [wrapRule, identifierRule],
    keyChains: [{ key: 'Tab', priority: KEY_CHAIN_PRIORITY.Tab.mathTabOut, id: 'automath.tabOut', run: tabOutOfMath }],
    completionFilter: mathCompletionFilter,
  },
};

export default feature;
