/**
 * Public API of the statistics feature (feature 16). Other features import
 * stats only through this file.
 *
 * - `statsEdit`: the annotation every statistics edit carries; automatic edits
 *   and other automations skip such transactions.
 * - `inStatField(state, pos)`: true inside a field of the statistic being
 *   filled in; leave those ranges alone.
 * - `formatTypedStatistic`: the formatter automatic math mode asks first.
 */
export { statsEdit } from '../../editor/core/autoEdit';
export { inStatField } from './fields';
export { formatTypedStatistic } from './typed';
export { STATS_SETTING_IDS } from './settings';
